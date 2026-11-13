import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { authCodes, people } from "@/db/schema";
import { record } from "@/server/kernel/audit";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import type { Workspace } from "@/server/kernel/workspaces";
import { codeEmail } from "@/server/email/templates/code";
import { markUrl } from "@/server/email/templates/header";
import { workspaceLogo } from "@/server/kernel/settings";
import { mailRelay, send } from "@/server/email/send";
import { CODE_TRIES, CODE_TTL_MS, codeMatches, formatCode, hashCode, newCode, normalizeCode, CODE_LENGTH } from "./code";
import { limitCodeRequest } from "./rate-limit";
import { describeDevice } from "./device";
import { createSession } from "./session";
import { currentTime } from "@/server/kernel/clock";

export type RequestMeta = { ip: string; userAgent: string | null; city: string | null };

export type CodeRequested = { ok: true } | { ok: false; retryInMinutes: number };

export type CodeChecked =
  | { ok: true; sessionToken: string; personId: string }
  | { ok: false; triesLeft: number | null; newCodeSent: boolean };

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

async function issue(tx: Tx, ws: Workspace, person: { id: string; name: string; email: string }, meta: RequestMeta, now: Date) {
  // A new code replaces any earlier one.
  await tx
    .update(authCodes)
    .set({ triesLeft: 0 })
    .where(and(eq(authCodes.personId, person.id), isNull(authCodes.usedAt)));
  const code = newCode();
  await tx.insert(authCodes).values({
    workspaceId: ws.id,
    personId: person.id,
    email: person.email,
    codeHash: hashCode(person.email, code),
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    createdAt: now,
    triesLeft: CODE_TRIES,
    ip: meta.ip,
  });
  await record(tx, { workspaceId: ws.id, personId: person.id }, { who: person.email, event: "auth.code_sent", details: { email: person.email } });
  return code;
}

async function findPerson(tx: Tx, email: string) {
  const [person] = await tx
    .select({ id: people.id, name: people.name, email: people.email, isAdmin: people.isAdmin })
    .from(people)
    .where(sql`lower(${people.email}) = ${email.trim().toLowerCase()}`);
  return person ?? null;
}

// 1a → 1c. Only the workspace's People get a code; anyone else sees the same screen and gets nothing.
export async function requestSignInCode(ws: Workspace, email: string, meta: RequestMeta, now = currentTime()): Promise<CodeRequested> {
  const normalized = email.trim().toLowerCase();
  const sent = await withWorkspace({ workspaceId: ws.id }, async (tx) => {
    const limited = await limitCodeRequest(tx, normalized, meta.ip, now);
    if (!limited.ok) return { limited, code: null, person: null, logoId: null };
    const person = await findPerson(tx, normalized);
    if (!person) return { limited, code: null, person: null, logoId: null };
    return { limited, code: await issue(tx, ws, person, meta, now), person, logoId: await workspaceLogo(tx) };
  });
  if (!sent.limited.ok) return sent.limited;
  if (sent.code && sent.person) await sendCode(ws, sent.person, sent.code, meta, now, sent.logoId);
  return { ok: true };
}

// Without a mail relay (the open Bike before its IT sets one), an admin's code is written once to the log, for
// whoever runs the server; anyone else gets nothing, and 1c reads the same for everyone (b-code-no-relay).
export const codeLogLine = (email: string, code: string) => `Sign-in code for ${email}: ${formatCode(code)} (expires in 10 minutes)`;

async function sendCode(ws: Workspace, person: { name: string; email: string; isAdmin: boolean }, code: string, meta: RequestMeta, now: Date, logoId: string | null) {
  if (!mailRelay()) return void (person.isAdmin ? console.log(codeLogLine(person.email, code)) : null);
  const device = describeDevice(meta.userAgent);
  await send(codeEmail({ to: person.email, firstName: firstName(person.name), company: ws.name, code, ...device, city: meta.city, at: now, timeZone: ws.timeZone, mark: markUrl({ subdomain: ws.subdomain, logoId }) }));
}

// 1c → Home, or 1d. Five wrong tries and the code is used up; a new one is sent if the rate limit allows.
export async function checkSignInCode(ws: Workspace, email: string, input: string, meta: RequestMeta, now = currentTime()): Promise<CodeChecked> {
  const normalized = email.trim().toLowerCase();
  const typed = normalizeCode(input);
  const result = await withWorkspace({ workspaceId: ws.id }, async (tx): Promise<CodeChecked & { resend?: { id: string; name: string; email: string } }> => {
    const [row] = await tx
      .select()
      .from(authCodes)
      .where(and(eq(authCodes.email, normalized), isNull(authCodes.usedAt), gt(authCodes.expiresAt, now), gt(authCodes.triesLeft, 0)))
      .orderBy(desc(authCodes.createdAt))
      .limit(1);
    if (!row || !row.personId) return { ok: false, triesLeft: null, newCodeSent: false };

    if (typed.length === CODE_LENGTH && codeMatches(row.codeHash, normalized, typed)) {
      await tx.update(authCodes).set({ usedAt: now }).where(eq(authCodes.id, row.id));
      const ctx = { workspaceId: ws.id, personId: row.personId };
      const sessionToken = await createSession(tx, ctx, now);
      await record(tx, ctx, { who: normalized, event: "auth.signin", details: { email: normalized } });
      return { ok: true, sessionToken, personId: row.personId };
    }

    const triesLeft = row.triesLeft - 1;
    await tx.update(authCodes).set({ triesLeft }).where(eq(authCodes.id, row.id));
    await record(tx, { workspaceId: ws.id, personId: row.personId }, { who: normalized, event: "auth.code_failed", details: { email: normalized, triesLeft } });
    if (triesLeft > 0) return { ok: false, triesLeft, newCodeSent: false };
    const person = await findPerson(tx, normalized);
    return { ok: false, triesLeft: 0, newCodeSent: false, resend: person ?? undefined };
  });

  if (!result.ok && result.triesLeft === 0 && "resend" in result && result.resend) {
    const again = await requestSignInCode(ws, normalized, meta, now);
    return { ok: false, triesLeft: 0, newCodeSent: again.ok };
  }
  if (result.ok) return { ok: true, sessionToken: result.sessionToken, personId: result.personId };
  return { ok: false, triesLeft: result.triesLeft, newCodeSent: result.newCodeSent };
}
