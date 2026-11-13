import { edition } from "@/edition";
import { and, eq, gt, isNull } from "drizzle-orm";
import { handoffTokens, people, sessions } from "@/db/schema";
import { record } from "@/server/kernel/audit";
import { withWorkspace, type Ctx, type Tx } from "@/server/kernel/tx";
import { hashToken, newToken } from "./tokens";
import { currentTime } from "@/server/kernel/clock";

export const SESSION_COOKIE = "bike_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const HANDOFF_TTL_MS = 60_000;

// Set on the workspace host only: no Domain, so one workspace's session never reaches another.
export function sessionCookie(token: string) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: edition.secureCookies(),
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  };
}

export async function createSession(tx: Tx, ctx: Ctx & { personId: string }, now = currentTime()): Promise<string> {
  const token = newToken();
  await tx.insert(sessions).values({
    id: hashToken(token),
    workspaceId: ctx.workspaceId,
    personId: ctx.personId,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    createdAt: now,
  });
  return token;
}

export type SignedIn = { id: string; name: string; email: string; title: string | null; isAdmin: boolean };

// The person behind a session cookie, in this workspace only. RLS hides sessions of other workspaces.
export async function personForSession(workspaceId: string, token: string | undefined, now = currentTime()): Promise<SignedIn | null> {
  if (!token) return null;
  return withWorkspace({ workspaceId }, async (tx) => {
    const [row] = await tx
      .select({ id: people.id, name: people.name, email: people.email, title: people.title, isAdmin: people.isAdmin, sessionWs: sessions.workspaceId })
      .from(sessions)
      .innerJoin(people, eq(people.id, sessions.personId))
      .where(and(eq(sessions.id, hashToken(token)), gt(sessions.expiresAt, now)));
    // Belt and braces: the session must belong to the workspace of this host.
    if (!row || row.sessionWs !== workspaceId) return null;
    const { sessionWs: _ws, ...person } = row;
    return person;
  });
}

// Sign up → the new subdomain. 60 seconds, one use, and only on the workspace it was made for.
export async function createHandoff(tx: Tx, ctx: Ctx & { personId: string }, now = currentTime()): Promise<string> {
  const token = newToken();
  await tx.insert(handoffTokens).values({
    tokenHash: hashToken(token),
    workspaceId: ctx.workspaceId,
    personId: ctx.personId,
    expiresAt: new Date(now.getTime() + HANDOFF_TTL_MS),
  });
  return token;
}

export async function redeemHandoff(workspaceId: string, token: string, now = currentTime()): Promise<string | null> {
  return withWorkspace({ workspaceId }, async (tx) => {
    const [row] = await tx
      .update(handoffTokens)
      .set({ usedAt: now })
      .where(and(eq(handoffTokens.tokenHash, hashToken(token)), isNull(handoffTokens.usedAt), gt(handoffTokens.expiresAt, now)))
      .returning();
    if (!row || row.workspaceId !== workspaceId) return null;
    return createSession(tx, { workspaceId, personId: row.personId }, now);
  });
}

// Log out: ends this host's session only (other workspaces stay signed in) and writes auth.signout.
export async function endSession(workspaceId: string, token: string | undefined): Promise<void> {
  if (!token) return;
  await withWorkspace({ workspaceId }, async (tx) => {
    const [ended] = await tx
      .delete(sessions)
      .where(eq(sessions.id, hashToken(token)))
      .returning({ personId: sessions.personId });
    if (!ended) return;
    const [person] = await tx.select({ email: people.email }).from(people).where(eq(people.id, ended.personId));
    await record(tx, { workspaceId }, { who: person?.email ?? "", event: "auth.signout", details: {} });
  });
}
