import { eq } from "drizzle-orm";
import { instanceSettings } from "@/db/schema";
import { edition } from "@/edition";
import { seal, SealBroken, unseal } from "@/server/crypto/secret";
import { checkAnthropicKey, type KeyCheck } from "@/server/ai/key-check";
import { mustBeAdmin } from "./admin";
import { record } from "./audit";
import { KernelError, type KernelCtx } from "./context";
import { withRoot, type Tx } from "./tx";
import { currentTime } from "./clock";

// The open Bike's AI settings (O3, docs/design/o3/a-ai-tab.png): the company's Anthropic key, set in Settings › AI
// and sealed with SESSION_SECRET, else ANTHROPIC_API_KEY from .env; and the monthly cap in dollars. Admins only, each
// change in the Audit log with the key's last four characters, never the key. The hosted service reads .env only.

const PURPOSE = "anthropic-key";
const TTL_MS = 30_000;

export type AiKey = { key: string; source: "settings" | "env"; last4: string };
type Stored = { key: string | null; last4: string | null; cap: number | null; broken: boolean };

let cached: { stored: Stored; at: number } | null = null;
export const forgetAiSettings = () => void (cached = null);

async function stored(): Promise<Stored> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.stored;
  const [row] = await withRoot((tx) => tx.select().from(instanceSettings).where(eq(instanceSettings.id, 1)));
  let key: string | null = null;
  let broken = false;
  if (row?.aiKeySealed) {
    try {
      key = unseal(row.aiKeySealed, PURPOSE);
    } catch (e) {
      if (!(e instanceof SealBroken)) throw e;
      broken = true; // SESSION_SECRET changed: the key must be added again
    }
  }
  const s = { key, last4: row?.aiKeyLast4 ?? null, cap: row?.aiCapUsd === null || row?.aiCapUsd === undefined ? null : Number(row.aiCapUsd), broken };
  cached = { stored: s, at: Date.now() };
  return s;
}

const last4 = (key: string) => key.slice(-4);

// The key every AI call uses, or null: no model.
export async function aiKey(env: Record<string, string | undefined> = process.env): Promise<AiKey | null> {
  const fromEnv = env.ANTHROPIC_API_KEY?.trim();
  if (edition.oneCompany()) {
    const s = await stored();
    if (s.key) return { key: s.key, source: "settings", last4: last4(s.key) };
  }
  return fromEnv ? { key: fromEnv, source: "env", last4: last4(fromEnv) } : null;
}

// The open Bike has a model when it has a key, even replaying recorded answers (its flows add one first); the hosted
// service replaying or recording answers always has one.
export async function hasModel(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (!edition.oneCompany() && (env.AI_PROVIDER === "fixtures" || env.AI_PROVIDER === "record")) return true;
  return (await aiKey(env)) !== null;
}

// The monthly cap in dollars, or null: none. Only the open Bike has one (the hosted service has credits).
export async function aiCap(): Promise<number | null> {
  return edition.oneCompany() ? (await stored()).cap : null;
}

// What Settings › AI shows about the key (never the key itself).
export async function aiKeyView(env: Record<string, string | undefined> = process.env) {
  const s = edition.oneCompany() ? await stored() : null;
  const k = await aiKey(env);
  return { source: k?.source ?? null, last4: k?.last4 ?? null, broken: s?.broken ?? false, cap: s?.cap ?? null };
}

export const AI_KEY = /^sk-ant-[A-Za-z0-9_-]{20,200}$/;
export const KEY_REFUSED: Record<Exclude<KeyCheck, "ok">, string> = {
  refused: "Anthropic doesn’t accept that key. Check it in your Anthropic console and paste it again.",
  error: "Anthropic couldn’t check the key just now. Try again in a few minutes.",
  unreachable: "Bike can’t reach Anthropic to check the key. Check that the server may reach api.anthropic.com.",
};

async function mustBeOwnBike(tx: Tx, ctx: KernelCtx) {
  await mustBeAdmin(tx, ctx);
  if (!edition.oneCompany()) throw new KernelError("AI settings are for a company’s own Bike.");
}

async function write(set: Partial<typeof instanceSettings.$inferInsert>, now: Date) {
  await withRoot((t) =>
    t.insert(instanceSettings).values({ id: 1, ...set, updatedAt: now }).onConflictDoUpdate({ target: instanceSettings.id, set: { ...set, updatedAt: now } }),
  );
  forgetAiSettings();
}

// Saves the key once Anthropic accepts it (check: tests pass their own).
export async function setAiKey(tx: Tx, ctx: KernelCtx, input: string, check: (key: string) => Promise<KeyCheck> = checkAnthropicKey) {
  await mustBeOwnBike(tx, ctx);
  const key = input.trim();
  if (!AI_KEY.test(key)) throw new KernelError("That isn’t an Anthropic key. It starts with sk-ant-.");
  const checked = await check(key);
  if (checked !== "ok") throw new KernelError(KEY_REFUSED[checked]);
  const now = ctx.now ?? currentTime();
  await write({ aiKeySealed: seal(key, PURPOSE), aiKeyLast4: last4(key) }, now);
  await record(tx, ctx, { who: ctx.actor.email, event: "ai.key_set", details: { key: `…${last4(key)}` }, at: now });
}

export async function removeAiKey(tx: Tx, ctx: KernelCtx) {
  await mustBeOwnBike(tx, ctx);
  const s = await stored();
  if (!s.key && !s.broken) throw new KernelError("No key is set here.");
  const now = ctx.now ?? currentTime();
  await write({ aiKeySealed: null, aiKeyLast4: null }, now);
  await record(tx, ctx, { who: ctx.actor.email, event: "ai.key_removed", details: { key: `…${s.last4 ?? ""}` }, at: now });
}

// O4: the newest release the daily check found (server/instance/updates.ts), and when it asked. The worker's own
// write, no person's, so no Audit log entry, like the health check.
export type ReleaseCheck = { version: string | null; url: string | null; checkedAt: Date | null };

export async function releaseCheck(): Promise<ReleaseCheck> {
  const [row] = await withRoot((tx) => tx.select().from(instanceSettings).where(eq(instanceSettings.id, 1)));
  return { version: row?.latestVersion ?? null, url: row?.latestUrl ?? null, checkedAt: row?.releaseCheckedAt ?? null };
}

export async function saveReleaseCheck(found: { version: string; url: string } | null, now: Date) {
  await write({ ...(found ? { latestVersion: found.version, latestUrl: found.url } : {}), releaseCheckedAt: now }, now);
}

// usd null: no cap.
export async function setAiCap(tx: Tx, ctx: KernelCtx, usd: number | null) {
  await mustBeOwnBike(tx, ctx);
  if (usd !== null && (!Number.isFinite(usd) || usd <= 0 || usd > 100_000)) throw new KernelError("A cap is a dollar amount above 0, up to 100,000.");
  const rounded = usd === null ? null : Math.round(usd * 100) / 100;
  const before = (await stored()).cap;
  const now = ctx.now ?? currentTime();
  await write({ aiCapUsd: rounded === null ? null : rounded.toFixed(2) }, now);
  await record(tx, ctx, { who: ctx.actor.email, event: "ai.cap_changed", details: { from: before, to: rounded }, at: now });
}
