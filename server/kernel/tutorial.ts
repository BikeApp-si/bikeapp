import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { capabilities, tutorialSeen, tutorials, workspaces } from "@/db/schema";
import { accessSummary, summaryHash, type AccessSummary } from "./access-summary";
import { currentTime } from "./clock";
import { AccessError, load, type KernelCtx } from "./context";
import type { Tx } from "./tx";

// A capability's tutorial (0.4, M24): one per version and kind of access, checked against that access before it's
// kept, so nobody reads a step they can't take. Written once; read back by everyone with the same access. Its card
// shows on a capability created from now on, and after a Customize change, for each person until "Got it", and again
// only when their own steps change.

export type TutorialStep = { title: string; text: string; does: { kind: "add" | "edit" | "move" | "read" | "wait"; sheet: string; step: string | null } };
export type Tutorial = { purpose: string; steps: TutorialStep[]; waits: string[]; cannot: string[] };
export type TutorialCard = { kind: "new" | "changed"; change: string | null; isNew: string[] } | null;

// What the person reads: their tutorial (or what's needed to write it), and its card.
export type TutorialState =
  | { ready: true; capability: string; tutorial: Tutorial; card: TutorialCard }
  | { ready: false; capability: string; company: string; summary: AccessSummary; version: number; hash: string };

const stepsHashOf = (t: Tutorial) => createHash("sha256").update(JSON.stringify(t.steps.map((s) => [s.title, s.text]))).digest("hex").slice(0, 32);

export async function tutorialState(tx: Tx, ctx: KernelCtx, capId: string): Promise<TutorialState> {
  const summary = await accessSummary(tx, ctx, capId); // refused when the person can't see the capability
  const loaded = await load(tx);
  const version = loaded.files.get(capId)!.version;
  const hash = summaryHash(summary);
  const [have] = await tx
    .select()
    .from(tutorials)
    .where(and(eq(tutorials.workspaceId, ctx.workspaceId), eq(tutorials.capabilityId, capId), eq(tutorials.version, version), eq(tutorials.accessHash, hash)));
  if (!have) {
    const [ws] = await tx.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, ctx.workspaceId));
    return { ready: false, capability: summary.capability, company: ws?.name ?? "", summary, version, hash };
  }
  const tutorial = have.page as Tutorial;
  return { ready: true, capability: summary.capability, tutorial, card: await cardFor(tx, ctx, capId, tutorial, have.stepsHash) };
}

async function cardFor(tx: Tx, ctx: KernelCtx, capId: string, tutorial: Tutorial, stepsHash: string): Promise<TutorialCard> {
  const [cap] = await tx.select({ introduce: capabilities.introduce, change: capabilities.changeTitle }).from(capabilities).where(eq(capabilities.id, capId));
  if (!cap?.introduce) return null;
  const [seen] = await tx.select().from(tutorialSeen).where(and(eq(tutorialSeen.workspaceId, ctx.workspaceId), eq(tutorialSeen.personId, ctx.actor.id), eq(tutorialSeen.capabilityId, capId)));
  if (!seen) return { kind: cap.change ? "changed" : "new", change: cap.change, isNew: [] };
  if (seen.stepsHash === stepsHash) return null;
  // Their steps changed since they last closed it: the ones they haven't read before are marked.
  const [before] = await tx.select({ page: tutorials.page }).from(tutorials).where(eq(tutorials.id, seen.tutorialId));
  const read = new Set(((before?.page as Tutorial | undefined)?.steps ?? []).map((s) => s.title));
  return { kind: "changed", change: cap.change, isNew: tutorial.steps.filter((s) => !read.has(s.title)).map((s) => s.title) };
}

// The answer, checked against the access it was written for: every step something that access allows, and no
// sheet or step of the capability named in a step that the reader doesn't have.
export function checkTutorial(summary: AccessSummary, t: Tutorial): string[] {
  const p: string[] = [];
  // An admin's "can't" names only what nobody can do here (S1): a limit the summary itself has.
  if (summary.admin) for (const line of t.cannot) if (!adminCannot(summary, line)) p.push(`“${line}”: this person is an admin and can do this; leave it out of cannot.`);
  const sheets = new Map(summary.sheets.map((s) => [s.name.toLowerCase(), s]));
  t.steps.forEach((s, i) => {
    const at = `Step ${i + 1} (“${s.title}”)`;
    const sheet = sheets.get(s.does.sheet.toLowerCase());
    if (!sheet) return void p.push(`${at}: “${s.does.sheet}” isn't a sheet this person sees.`);
    if (s.does.kind === "add" && !sheet.add) p.push(`${at}: this person can't add to ${sheet.name}.`);
    if (s.does.kind === "edit" && !sheet.edit) p.push(`${at}: this person can't change ${sheet.name}.`);
    // A ledger's entries are only added (M29): a wrong one is reversed, never changed or deleted.
    // Only an instruction to ("change it", "delete the move"), not saying it can't be ("never changed or deleted").
    if (sheet.reverse !== undefined && /\b(delete|change|edit) (it|them|the|a|an|this|that)\b/i.test(`${s.title} ${s.text}`))
      p.push(`${at}: ${sheet.many} are only added; a wrong one is reversed${sheet.reverse ? "" : " by someone who may add them"}, never changed or deleted.`);
    // A dated sheet's row in force is kept as it is (M30): a change is a new row from the date it changes.
    if (sheet.dated && s.does.kind === "edit" && !/\b(new one|add|still to come|later)\b/i.test(`${s.title} ${s.text}`))
      p.push(`${at}: ${sheet.many} in force aren't changed; a change is a new one from the date it changes.`);
    if (s.does.kind === "move" && !sheet.movesTo.some((m) => m.toLowerCase() === (s.does.step ?? "").toLowerCase()))
      p.push(`${at}: this person can't move ${sheet.many} to “${s.does.step ?? ""}”; that belongs under waits.`);
    // A step they take mustn't send them to a step they can't move into.
    if (s.does.kind === "add" || s.does.kind === "edit" || s.does.kind === "move")
      for (const name of sheet.steps)
        if (!sheet.movesTo.includes(name) && name !== s.does.step && mentions(`${s.title} ${s.text}`, `move it to ${name}`)) p.push(`${at}: this person can't move ${sheet.many} to ${name}.`);
  });
  return p;
}

const mentions = (text: string, phrase: string) => text.toLowerCase().includes(phrase.toLowerCase());

// One line of an admin's "can't", kept only when it names a limit nobody gets past: a step the submitter can't take
// (said as "your own"), a step only the submitter moves out of, a ledger nobody adds to (so nobody reverses), and sheets
// nobody adds to, deletes from or changes (a ledger's entries, a dated sheet's rows in force). Anything else an admin can do.
export function adminCannot(summary: AccessSummary, line: string): boolean {
  const l = line.toLowerCase();
  const sheets = summary.sheets;
  const rules = sheets.flatMap((s) => s.stepRules);
  if (/\b(approve|decline|reject|accept|decide)/.test(l)) return /\b(your own|you submitted|you added|you asked for|yourself|themselves)\b/.test(l) && rules.some((r) => r.includes("not by the person who submitted"));
  if (/\brevers/.test(l)) return sheets.some((s) => s.reverse === false);
  if (/\bmove\b.*\bout of\b/.test(l)) return rules.some((r) => r.startsWith("Out of "));
  if (/\b(delete|remove)/.test(l)) return sheets.some((s) => !s.delete);
  if (/\b(change|edit)/.test(l)) return sheets.some((s) => !s.edit || s.reverse !== undefined || s.dated);
  if (/\b(add|record|create|log)/.test(l)) return sheets.some((s) => !s.add);
  return false;
}

// Kept once per version and access; a second writer for the same key keeps the first.
export async function saveTutorial(tx: Tx, ctx: KernelCtx, capId: string, version: number, hash: string, t: Tutorial) {
  await tx
    .insert(tutorials)
    .values({ workspaceId: ctx.workspaceId, capabilityId: capId, version, accessHash: hash, page: t, stepsHash: stepsHashOf(t), writtenAt: ctx.now ?? currentTime() })
    .onConflictDoNothing();
}

// "Got it": the tutorial this person read is the one they've closed.
export async function closeTutorial(tx: Tx, ctx: KernelCtx, capId: string): Promise<void> {
  const summary = await accessSummary(tx, ctx, capId);
  const version = (await load(tx)).files.get(capId)!.version;
  const [t] = await tx
    .select({ id: tutorials.id, stepsHash: tutorials.stepsHash })
    .from(tutorials)
    .where(and(eq(tutorials.workspaceId, ctx.workspaceId), eq(tutorials.capabilityId, capId), eq(tutorials.version, version), eq(tutorials.accessHash, summaryHash(summary))));
  if (!t) throw new AccessError("There's no tutorial to close yet.");
  const at = ctx.now ?? currentTime();
  await tx
    .insert(tutorialSeen)
    .values({ workspaceId: ctx.workspaceId, personId: ctx.actor.id, capabilityId: capId, tutorialId: t.id, stepsHash: t.stepsHash, seenAt: at })
    .onConflictDoUpdate({ target: [tutorialSeen.workspaceId, tutorialSeen.personId, tutorialSeen.capabilityId], set: { tutorialId: t.id, stepsHash: t.stepsHash, seenAt: at } });
}
