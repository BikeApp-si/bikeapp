import { companyEntries } from "../rule-set";
import { and, eq, isNull, sql } from "drizzle-orm";
import { sameJson } from "@/lib/same-json";
import { capabilities, rows } from "@/db/schema";
import { mustBeAdmin } from "../admin";
import { record } from "../audit";
import { getFile, newChangeSet, saveVersion } from "../capabilities";
import { fillNewComputed } from "../changesets";
import { KernelError, load, startWork, type KernelCtx } from "../context";
import { renderCapabilityText, type TextSection } from "../render-text";
import type { CapabilityFile } from "../schema/file";
import { stepColumn } from "../steps";
import { atomic, type Tx } from "../tx";
import { checkCustomize, stepKey, type StepCounts } from "./check";
import { impactOf, type Impact } from "./impact";
import { movesOf } from "./link-instead";
import { applyMoves, planMove, type MovePlan, type World } from "./move";
import { currentTime } from "../clock";

// A Customize change set, previewed (6c, 6f, 6h, 6k) and applied (6d–6e, 6i–6j). One or more capabilities:
// the one being customized, and any whose rules the dependency check fixed. Nothing is live until Apply,
// which saves a new version of each file in one transaction (all or nothing).

export type Edit = { before: CapabilityFile; after: CapabilityFile; changes: string[] };
export type Edits = ReadonlyMap<string, Edit>;

// Rows at each step of the capabilities being changed, for refusing a step removal in plain words.
async function stepCounts(tx: Tx, files: Iterable<[string, CapabilityFile]>): Promise<StepCounts> {
  const out = new Map<string, number>();
  for (const [capId, file] of files)
    for (const sheet of file.sheets) {
      const col = stepColumn(sheet);
      if (!col) continue;
      const counted = await tx
        .select({ step: sql<string>`${rows.data}->>${col.id}`, n: sql<number>`count(*)::int` })
        .from(rows)
        .where(and(eq(rows.capabilityId, capId), eq(rows.sheetId, sheet.id), isNull(rows.deletedAt)))
        .groupBy(sql`1`);
      for (const c of counted) if (c.step) out.set(stepKey(capId, sheet.id, c.step), c.n);
    }
  return out;
}

// The kernel's checks on a change set without showing or saving anything: for the AI's retry loop (C1), and
// again by preview and Apply.
export async function customizeProblems(tx: Tx, edits: Edits): Promise<string[]> {
  const loaded = await load(tx);
  const before = new Map([...loaded.files].map(([id, f]) => [id, f.file] as const));
  const after = new Map([...edits].map(([id, e]) => [id, e.after] as const));
  return checkCustomize(before, after, new Set(loaded.people.keys()), await stepCounts(tx, [...edits].map(([id, e]) => [id, e.before] as [string, CapabilityFile])), companyEntries(loaded.rules));
}

// The capabilities before the change set and as it leaves them, for a move (move.ts).
async function worldOf(tx: Tx, edits: Edits): Promise<World> {
  const before = new Map([...(await load(tx)).files].map(([id, f]) => [id, f.file] as const));
  const after = new Map(before);
  for (const [id, e] of edits) after.set(id, e.after);
  return { before, after };
}

const movesIn = (edits: Edits) => [...edits].flatMap(([id, e]) => movesOf(id, e.before, e.after));

// moves (M27): what each data move does to today's rows; one with rows it can't map can't be applied.
export type Preview = { problems: string[]; impact: Impact | null; text: TextSection[]; version: number; moves: MovePlan[] };

// Admins only. The checks, what it does to today's rows, and the text as it will read; `customize.preview`
// records that it was shown.
export async function previewCustomize(tx: Tx, ctx: KernelCtx, capId: string, edits: Edits, chatId: string): Promise<Preview> {
  return atomic(tx, async (tx) => {
    await mustBeAdmin(tx, ctx);
    const main = edits.get(capId);
    const now = await getFile(tx, capId);
    if (!main || !now) throw new KernelError("That app doesn't exist.");
    const problems = await customizeProblems(tx, edits);
    const loaded = await load(tx);
    const files = new Map([...loaded.files].map(([id, f]) => [id, f.file] as const));
    for (const [id, e] of edits) files.set(id, e.after);
    const text = renderCapabilityText(main.after, { capId, files, personName: (id) => loaded.people.get(id)?.name, viewerId: null, formats: loaded.formats });
    const impact = problems.length ? null : await impactOf(await startWork(tx, ctx), capId, main.before, main.after);
    const world = await worldOf(tx, edits);
    const moves = problems.length ? [] : await Promise.all(movesIn(edits).map((m) => planMove(tx, world, m)));
    if (!problems.length)
      await record(tx, ctx, { who: ctx.actor.email, capabilityId: capId, event: "customize.preview", details: { version: now.version + 1, changes: main.changes.join("; ") }, chatId, at: ctx.now });
    return { problems, impact, text, version: now.version + 1, moves };
  });
}

// Apply: each file as the preview saw it, checked again, then one change set with a new version of each and
// its `customize.saved` entry pointing to the change set and the chat.
// title: what the change is called ("Legal review step"), for the tutorial card that says it changed (0.4, M24).
export async function applyCustomize(tx: Tx, ctx: KernelCtx, capId: string, edits: Edits, chatId: string, title?: string | null): Promise<{ changeSetId: string; versions: Map<string, number> }> {
  return atomic(tx, async (tx) => {
    await mustBeAdmin(tx, ctx);
    const from = new Map<string, number>();
    for (const [id, e] of edits) {
      const now = await getFile(tx, id);
      if (!now) throw new KernelError("That app doesn't exist.");
      if (!sameJson(now.file, e.before)) throw new KernelError(`${now.file.name} has changed since this preview. Send your message again to see it as it is now.`);
      from.set(id, now.version);
    }
    const problems = await customizeProblems(tx, edits);
    if (problems.length) throw new KernelError(problems[0]!, problems);

    const at = ctx.now ?? currentTime();
    const both = await worldOf(tx, edits);
    const moves = movesIn(edits);
    const opts = { source: "customize" as const, kind: moves.length ? ("restructure" as const) : ("add" as const), chatId, at, others: both.after };
    // The capability being customized first, then the ones its fixes touch.
    const order = [capId, ...[...edits.keys()].filter((id) => id !== capId)];
    const changeSetId = await newChangeSet(tx, ctx, opts, order.map((id) => ({ capabilityId: id, fromVersion: from.get(id)!, toVersion: from.get(id)! + 1 })));
    const versions = new Map<string, number>();
    for (const id of order) {
      const e = edits.get(id)!;
      const saved = await saveVersion(tx, ctx, id, e.after, { ...opts, changeSetId, event: "customize.saved", details: { changes: e.changes.join("; ") } });
      await fillNewComputed(tx, ctx, id, e.before, e.after);
      versions.set(id, saved.version);
    }
    // The rows a data move fills (M27), planned again on the rows as they are now; refused if any can't be mapped.
    if (moves.length) await applyMoves(tx, ctx, both, moves, { changeSetId, chatId, at });
    // Its tutorial card comes back for anyone whose steps this changes, named by the change.
    await tx.update(capabilities).set({ introduce: true, changeTitle: title ?? null }).where(eq(capabilities.id, capId));
    return { changeSetId, versions };
  });
}
