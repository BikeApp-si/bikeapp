import { eq, sql } from "drizzle-orm";
import { instanceSetup } from "@/db/schema";
import { db } from "@/db/client";
import { checkAddress, suggestAddress } from "@/lib/address";
import { isTimeZone } from "@/lib/timezones";
import { CODE_TRIES, codeMatches, formatCode, hashCode, newCode } from "@/server/auth/code";
import { withRoot, withWorkspace, type Tx } from "./tx";
import { AI_KEY, KEY_REFUSED, setAiKey } from "./instance-settings";
import { checkAnthropicKey, type KeyCheck } from "@/server/ai/key-check";
import { createWorkspace } from "./workspaces";
import { currentTime } from "./clock";

// The open Bike's first run (O2, docs/design/o2/a-first-run.png): before any company exists, whoever has the
// setup code from Bike's log creates the company and becomes its first admin. The code proves they run the server.

type Log = (line: string) => void;
// log: where the code goes (Bike's log); companies: how many the database holds (tests pass their own).
// checkKey: whether Anthropic takes the key first run was given (tests pass their own).
type Opts = { log?: Log; now?: Date; companies?: () => Promise<number>; checkKey?: (key: string) => Promise<KeyCheck> };

const KEY = "instance-setup"; // the code is hashed as sign-in codes are, under this name in place of an email

export const setupCodeLine = (code: string) => `Setup code for this Bike: ${formatCode(code)}. Open Bike's address to create your company.`;
export const WRONG_SETUP_CODE = (left: number) => `That code isn’t right. ${left} ${left === 1 ? "try" : "tries"} left.`;
export const SETUP_CODE_USED_UP = "That code is used up. A new one is in Bike’s log.";
export const ALREADY_SET_UP = "This Bike is already set up.";

export async function companiesInDatabase(): Promise<number> {
  const [row] = await db().execute<{ n: number }>(sql`select count(*)::int as n from all_workspaces()`);
  return row?.n ?? 0;
}

async function writeCode(tx: Tx, log: Log, now: Date) {
  const code = newCode();
  const values = { codeHash: hashCode(KEY, code), triesLeft: CODE_TRIES, createdAt: now };
  await tx.insert(instanceSetup).values({ id: 1, ...values }).onConflictDoUpdate({ target: instanceSetup.id, set: values });
  log(setupCodeLine(code));
}

// When Bike starts (fresh: a new code each start, so a lost one comes back with a restart) and when the first-run
// page opens (a code only if none is waiting). Nothing once a company exists.
export async function ensureSetupCode({ fresh = false, log = console.log, now = currentTime(), companies = companiesInDatabase }: Opts & { fresh?: boolean } = {}): Promise<void> {
  if ((await companies()) > 0) return;
  await withRoot(async (tx) => {
    const [row] = await tx.select().from(instanceSetup).where(eq(instanceSetup.id, 1)).for("update");
    if (row?.doneAt) return;
    if (!row || fresh || row.triesLeft <= 0) await writeCode(tx, log, now);
  });
}

// aiKey: the company's Anthropic key, optional (O3, e-first-run-key); it can be added later in Settings › AI.
export type FirstRunInput = { code: string; company: string; name: string; email: string; timeZone: string; aiKey?: string };
export type FirstRunResult = { ok: true; email: string } | { ok: false; error: string; codeWrong?: boolean };

// The company's address as the database keeps it. The open Bike never shows or reads it (INSTANCE_URL is its address).
export function storedAddress(company: string): string {
  const s = suggestAddress(company);
  return checkAddress(s).ok ? s : "company";
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkInput(input: FirstRunInput): string | null {
  if (!input.company.trim()) return "Please enter your company name.";
  if (!input.name.trim()) return "Please enter your name.";
  if (!EMAIL.test(input.email.trim())) return "Please enter your work email.";
  if (!isTimeZone(input.timeZone)) return "Please pick a time zone.";
  return null;
}

// Create company: the code is checked first (5 tries, then a new one in the log), then the company and its
// first admin are made. The row stays locked until then, so two people at once make one company, not two.
export async function createFirstCompany(input: FirstRunInput, { log = console.log, now = currentTime(), companies = companiesInDatabase, checkKey = checkAnthropicKey }: Opts = {}): Promise<FirstRunResult> {
  const invalid = checkInput(input);
  if (invalid) return { ok: false, error: invalid };
  // The key is checked before the code, so a mistyped key costs no try.
  const aiKey = input.aiKey?.trim() || null;
  if (aiKey) {
    if (!AI_KEY.test(aiKey)) return { ok: false, error: "That isn’t an Anthropic key. It starts with sk-ant-." };
    const checked = await checkKey(aiKey);
    if (checked !== "ok") return { ok: false, error: KEY_REFUSED[checked] };
  }
  return withRoot(async (tx): Promise<FirstRunResult> => {
    const [row] = await tx.select().from(instanceSetup).where(eq(instanceSetup.id, 1)).for("update");
    if (row?.doneAt || (await companies()) > 0) return { ok: false, error: ALREADY_SET_UP };
    if (!row || row.triesLeft <= 0) {
      await writeCode(tx, log, now);
      return { ok: false, error: SETUP_CODE_USED_UP, codeWrong: true };
    }
    if (!codeMatches(row.codeHash, KEY, input.code)) {
      const left = row.triesLeft - 1;
      if (left <= 0) {
        await writeCode(tx, log, now);
        return { ok: false, error: SETUP_CODE_USED_UP, codeWrong: true };
      }
      await tx.update(instanceSetup).set({ triesLeft: left }).where(eq(instanceSetup.id, 1));
      return { ok: false, error: WRONG_SETUP_CODE(left), codeWrong: true };
    }
    const email = input.email.trim().toLowerCase();
    const made = await createWorkspace({
      subdomain: storedAddress(input.company),
      name: input.company,
      timeZone: input.timeZone,
      admin: { name: input.name, email },
      at: now,
    });
    if (aiKey) {
      const ctx = { workspaceId: made.workspaceId, actor: { id: made.personId, email }, now };
      await withWorkspace({ workspaceId: made.workspaceId, personId: made.personId }, (t) => setAiKey(t, ctx, aiKey, async () => "ok"));
    }
    await tx.update(instanceSetup).set({ doneAt: now, triesLeft: 0 }).where(eq(instanceSetup.id, 1));
    return { ok: true, email };
  });
}
