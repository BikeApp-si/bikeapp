import { readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import nodemailer from "nodemailer";
import { db } from "@/db/client";
import { deleteFile, filesDir, getFile, putFile, storageEnv } from "@/server/files/storage";
import { scan, ScanUnavailable } from "@/server/files/scan";
import { emailProvider, NO_RELAY } from "@/server/email/send";
import { aiKey } from "@/server/kernel/instance-settings";
import { checkAnthropicKey } from "@/server/ai/key-check";
import { instanceSetup } from "@/db/schema";
import { withRoot } from "@/server/kernel/tx";
import { backupsDir, listBackups } from "./backup";

// Settings › Instance (docs/design/o2/c-instance.png, c2): what the open Bike needs, each with its state and, when
// it fails, how to fix it. Every check is bounded in time and never throws.

export type HealthItem = { name: string; ok: boolean; says: string; fix?: string };

const TIMEOUT_MS = 5_000;
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const PROBE = "instance/health-check.txt";

function within<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms))]);
}

// The updates this Bike ships with (drizzle's list), to compare with those the database has.
export function migrationsShipped(): number {
  const journal = JSON.parse(readFileSync(path.join(process.cwd(), "db/migrations/meta/_journal.json"), "utf8")) as { entries: unknown[] };
  return journal.entries.length;
}

async function migrationsApplied(): Promise<number> {
  const [row] = await db().execute<{ n: number }>(sql`select migrations_applied() as n`);
  return row?.n ?? 0;
}

// shipped and applied: tests pass their own.
export async function databaseItem(shipped = migrationsShipped(), applied = migrationsApplied): Promise<HealthItem> {
  const name = "Database";
  try {
    const missing = shipped - (await within(applied()));
    if (missing <= 0) return { name, ok: true, says: "Answers, and every update to it is applied." };
    return {
      name,
      ok: false,
      says: `${missing} ${missing === 1 ? "update to it isn’t" : "updates to it aren’t"} applied.`,
      fix: "Restart Bike’s web container (docker compose restart web): it applies them when it starts.",
    };
  } catch {
    return { name, ok: false, says: "Doesn’t answer.", fix: "Check that the database is running (docker compose ps postgres) and that the passwords in .env are the ones it was set up with." };
  }
}

export async function storageItem(): Promise<HealthItem> {
  const name = "File storage";
  const disk = process.env.STORAGE_PROVIDER === "disk";
  const where = disk ? filesDir() : `${storageEnv().bucket} at ${hostOf(storageEnv().endpoint)}`;
  try {
    const body = new TextEncoder().encode(`Bike's health check, ${new Date().toISOString()}`);
    await within(putFile(PROBE, body, "text/plain"));
    const back = await within(getFile(PROBE));
    await within(deleteFile(PROBE));
    if (!back || Buffer.compare(Buffer.from(back.body), Buffer.from(body)) !== 0) throw new Error("read back differs");
    return { name, ok: true, says: `${disk ? "On this server’s disk" : `In ${where}`}. A test file was saved, read and removed.` };
  } catch {
    return {
      name,
      ok: false,
      says: `Bike can’t save files to ${where}.`,
      fix: disk
        ? "Check that the files volume is mounted and that Bike may write to it, then run again."
        : "Check S3_ENDPOINT, S3_BUCKET and its keys in .env, then restart Bike.",
    };
  }
}

export async function scannerItem(): Promise<HealthItem> {
  const name = "Virus scanner";
  try {
    const result = await within(scan(new TextEncoder().encode(EICAR)));
    if (!result.clean) return { name, ok: true, says: "Answers, and caught the test virus." };
    return { name, ok: false, says: "Answers, but missed the test virus.", fix: "Its virus list may still be downloading. Wait a few minutes, then run again." };
  } catch (e) {
    if (!(e instanceof ScanUnavailable) && !(e instanceof Error && e.message === "timed out")) throw e;
    return {
      name,
      ok: false,
      says: "Doesn’t answer.",
      fix: "Start it with docker compose up -d clamav. Its first start takes a few minutes while it downloads its virus list. Until it answers, uploads are refused.",
    };
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

export async function emailItem(): Promise<HealthItem> {
  const name = "Email";
  const provider = emailProvider();
  if (provider === "none")
    return { name, ok: false, says: NO_RELAY, fix: "Set SMTP_URL in .env and restart Bike. Until then, admins find their sign-in codes in Bike’s log and no one else can sign in." };
  if (provider === "postmark") return { name, ok: true, says: "Sends through Postmark." };
  if (provider !== "smtp") return { name, ok: true, says: `Sends through ${provider}.` };
  const url = process.env.SMTP_URL ?? "smtp://localhost:1025";
  const host = hostOf(url);
  try {
    await within(nodemailer.createTransport(url).verify());
    return { name, ok: true, says: `Sends through ${host}.` };
  } catch {
    return { name, ok: false, says: `${host} doesn’t answer.`, fix: "Check SMTP_URL in .env (its host, port, user and password), then restart Bike." };
  }
}

// The server's clock against the database's: dates, reminders and the Audit log depend on it.
export async function clockItem(dbNow: () => Promise<Date> = databaseNow): Promise<HealthItem> {
  const name = "Clock";
  try {
    const before = Date.now();
    const theirs = (await within(dbNow())).getTime();
    const ours = (before + Date.now()) / 2;
    const minutes = Math.round(Math.abs(ours - theirs) / 60_000);
    if (Math.abs(ours - theirs) < 60_000) return { name, ok: true, says: "Matches the database’s clock." };
    return {
      name,
      ok: false,
      says: `${minutes || 1} ${minutes === 1 ? "minute" : "minutes"} ${ours < theirs ? "behind" : "ahead of"} the database.`,
      fix: "Turn on time sync (NTP) on the server. Dates, reminders and the Audit log use this clock.",
    };
  } catch {
    return { name, ok: false, says: "Can’t compare it: the database doesn’t answer.", fix: "Fix the database first, then run again." };
  }
}

async function databaseNow(): Promise<Date> {
  const [row] = await db().execute<{ now: string }>(sql`select now()::text as now`);
  return new Date(row!.now);
}

// The company's Anthropic key (Settings › AI, else .env), checked by listing models: no AI call, no cost.
export async function aiItem(env: Record<string, string | undefined> = process.env): Promise<HealthItem> {
  const name = "AI";
  if (env.AI_PROVIDER === "fixtures") return { name, ok: true, says: "Replays recorded answers (tests)." };
  const k = await aiKey(env);
  if (!k)
    return {
      name,
      ok: false,
      says: "No Anthropic key is set.",
      fix: "Add your company’s key in Settings › AI. Without it, apps can’t be built or changed from chat; everything else works.",
    };
  const where = k.source === "settings" ? "in Settings › AI" : "in .env";
  const checked = await checkAnthropicKey(k.key);
  if (checked === "ok") return { name, ok: true, says: "Your Anthropic key works." };
  if (checked === "refused") return { name, ok: false, says: "Anthropic refused the key.", fix: `Check the key ${where} against your Anthropic console, and replace it.` };
  if (checked === "error") return { name, ok: false, says: "Anthropic answered with an error.", fix: "Run again in a few minutes. If it stays, check status.anthropic.com." };
  return { name, ok: false, says: "Anthropic can’t be reached.", fix: "Check that the server may reach api.anthropic.com on port 443." };
}

const DAY_MS = 24 * 60 * 60_000;

function size(bytes: number): string {
  const mb = bytes / 1_000_000;
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

// "today at 02:00", "yesterday at 02:00", "Nov 11 at 02:00", in the company's time zone.
export function when(at: Date, now: Date, timeZone: string): string {
  const day = (d: Date) => d.toLocaleDateString("en-CA", { timeZone });
  const time = at.toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" });
  if (day(at) === day(now)) return `today at ${time}`;
  if (day(at) === day(new Date(now.getTime() - DAY_MS))) return `yesterday at ${time}`;
  return `${at.toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric" })} at ${time}`;
}

async function firstRunDone(): Promise<Date | null> {
  const [row] = await withRoot((tx) => tx.select({ doneAt: instanceSetup.doneAt }).from(instanceSetup));
  return row?.doneAt ?? null;
}

// O4 (docs/design/o4/a-instance-update.png, b): the newest backup in the backups folder; failing when there has been
// none for two days, or when Bike can't write there. dir, now and doneAt: tests pass their own.
export async function backupsItem({ timeZone = "UTC", dir = backupsDir(), now = new Date(), doneAt = firstRunDone }: { timeZone?: string; dir?: string; now?: Date; doneAt?: () => Promise<Date | null> } = {}): Promise<HealthItem> {
  const name = "Backups";
  const probe = path.join(dir, ".health-check");
  try {
    await within(writeFile(probe, "Bike's health check"));
    await rm(probe, { force: true });
  } catch {
    return {
      name,
      ok: false,
      says: "Bike can’t write to the backups folder.",
      fix: "Restart Bike (docker compose up -d): it makes the backups folder beside compose.yaml its own as it starts. If it stays, check the server’s disk has room.",
    };
  }
  const list = await listBackups(dir);
  const newest = list[0];
  const stale = {
    name,
    ok: false,
    says: "No backup in the last two days.",
    fix: "Check that the worker is running (docker compose ps worker) and that the backups folder beside compose.yaml can be written. To make one now: docker compose exec web bike backup.",
  };
  if (!newest) {
    const done = await doneAt().catch(() => null);
    if (done && now.getTime() - done.getTime() > 2 * DAY_MS) return stale;
    return { name, ok: true, says: "None yet. The first is made tonight at 02:00." };
  }
  if (now.getTime() - newest.at.getTime() > 2 * DAY_MS) return stale;
  const nightly = list.filter((b) => b.why === "nightly").length;
  const kept = nightly ? `${nightly} nightly ${nightly === 1 ? "one" : "ones"} kept` : `${list.length} kept`;
  return { name, ok: true, says: `Last one ${when(newest.at, now, timeZone)}, ${size(newest.bytes)}. ${kept} in the backups folder.` };
}

// timeZone: the company's, for when the last backup was (Settings › Instance); /healthz/full shows no times.
export async function healthItems(timeZone?: string): Promise<HealthItem[]> {
  return Promise.all([databaseItem(), storageItem(), scannerItem(), emailItem(), clockItem(), aiItem(), backupsItem({ timeZone })]);
}

// /healthz/full for the open Bike: each item's state and fix as plain text (no hosts or paths: anyone may read it).
// 503 when Bike can't do its work (database, files, scanner); email and AI are choices.
export async function healthText(): Promise<{ status: 200 | 503; body: string }> {
  const items = await healthItems();
  const needed = ["Database", "File storage", "Virus scanner"];
  const down = items.some((i) => !i.ok && needed.includes(i.name));
  const body = items.map((i) => (i.ok ? `${i.name}: ok` : `${i.name}: not ok. ${i.fix ?? ""}`.trim())).join("\n");
  return { status: down ? 503 : 200, body: `${body}\n` };
}
