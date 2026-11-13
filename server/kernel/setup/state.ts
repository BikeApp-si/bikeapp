import { forgetSetup } from "../setup-cache";
import { eq } from "drizzle-orm";
import { workspaces } from "@/db/schema";
import { mustBeAdmin } from "../admin";
import { KernelError, type KernelCtx } from "../context";
import type { Tx } from "../tx";
import type { OrgReading } from "./organization";
import type { TeamDraft } from "./team";
import { currentTime } from "../clock";

// Where setup is (2b–2f) and what was said on the current step, kept on the workspace while setup runs. It
// isn't a chat: it is never listed in Chats, and it is cleared when setup is done.

export type SetupFile = { name: string; detail: string };

export type SetupMessage =
  | { from: "admin"; text: string; files: SetupFile[] }
  | { from: "bike"; status: "working"; since: string }
  | { from: "bike"; status: "done"; text: string; organization?: OrgReading; team?: TeamDraft }
  | { from: "bike"; status: "failed"; text: string };

export type SetupState = {
  step: "organization" | "team" | "done";
  messages: SetupMessage[];
  done?: { leftOut: string[]; noManager: string[] };
};


export async function readSetup(tx: Tx, ctx: KernelCtx) {
  await mustBeAdmin(tx, ctx);
  const [ws] = await tx.select({ setup: workspaces.setup, doneAt: workspaces.setupDoneAt }).from(workspaces);
  if (!ws) throw new KernelError("No workspace.");
  const state: SetupState = (ws.setup as SetupState | null) ?? { step: ws.doneAt ? "done" : "organization", messages: [] };
  return { state, doneAt: ws.doneAt };
}

// Setup's own writes; once it is done, only the done summary stays.
export async function writeSetup(tx: Tx, ctx: KernelCtx, state: SetupState, opts: { finish?: boolean } = {}) {
  await mustBeAdmin(tx, ctx);
  const set: Partial<typeof workspaces.$inferInsert> = { setup: state };
  if (opts.finish) set.setupDoneAt = ctx.now ?? currentTime();
  await tx.update(workspaces).set(set).where(eq(workspaces.id, ctx.workspaceId));
  forgetSetup();
}

// Setup can't be changed once it is done (2f has no reply box; People takes changes after it).
export async function openSetup(tx: Tx, ctx: KernelCtx, step: SetupState["step"]) {
  const { state, doneAt } = await readSetup(tx, ctx);
  if (doneAt) throw new KernelError("Setup is done. Make changes in People.");
  if (state.step !== step) throw new KernelError("That step is over. Reload the page.");
  if (state.messages.some((m) => m.from === "bike" && m.status === "working" && !stale(m.since, ctx.now))) throw new KernelError("Bike is still reading the last message.");
  return state;
}

// A reading still working after 10 minutes has stopped (as a chat reply does).
export const stale = (since: string, now = currentTime()) => now.getTime() - Date.parse(since) > 10 * 60_000;

export const lastReading = (s: SetupState) => {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i]!;
    if (m.from === "bike" && m.status === "done" && (m.organization || m.team)) return m;
  }
  return null;
};

// Whether setup is done (Home sends an admin to setup until it is).
export async function setupDone(tx: Tx): Promise<boolean> {
  const [ws] = await tx.select({ doneAt: workspaces.setupDoneAt }).from(workspaces);
  return !!ws?.doneAt;
}
