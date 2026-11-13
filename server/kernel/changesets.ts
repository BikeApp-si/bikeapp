import { and, eq, isNull } from "drizzle-orm";
import { sameJson } from "@/lib/same-json";
import { capabilities, outbox, rows } from "@/db/schema";
import { mustBeAdmin } from "./admin";
import { capabilitiesFor, createCapability, getFile, newChangeSet, saveVersion } from "./capabilities";
import { computeStored, stored } from "./compute";
import { KernelError, load, startWork, type KernelCtx } from "./context";
import { movesOf } from "./customize/link-instead";
import { applyMoves } from "./customize/move";
import { notAdditive } from "./plans/compile";
import type { CheckedPlan } from "./plans/plan";
import { importRows, type ImportGaps, type NewRow } from "./rows";
import type { CapabilityFile, Sheet } from "./schema/file";
import { atomic, type Tx } from "./tx";
import { currentTime } from "./clock";

// Create (5h, 5j): a checked plan applied as one change set. All or nothing: the new capability, a new
// version of each capability its Also changes add to, and the rows of an attached file, in one transaction.
// Access is checked per capability; each one gets its Audit entry, pointing to the change set and the chat.

export type Apply = {
  plan: CheckedPlan;
  newId: string;
  chatId: string;
  // What each Also change says, per capability, for its Audit entry ("Add a Billed step after Received").
  changes: Map<string, string[]>;
  // Files whose rows come in with it, in order (a build brings several, one sheet each).
  imports?: { sheetId: string; rows: NewRow[]; fileName: string; gaps?: ImportGaps }[];
  source?: "plan" | "build";
  email?: boolean; // "I'll email you when it's ready" (5h); a build has no such email
};

const references = (file: CapabilityFile, id: string) => JSON.stringify(file).includes(id);

export async function applyPlan(tx: Tx, ctx: KernelCtx, a: Apply): Promise<{ capabilityId: string; changeSetId: string }> {
  return atomic(tx, async (tx) => {
    await mustBeAdmin(tx, ctx);
    const { plan } = a;
    if (plan.problems.length) throw new KernelError(plan.problems[0]!, plan.problems);
    if (plan.restructures.length) throw new KernelError("One change moves data in a way Bike can't do yet.");
    const [taken] = await tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.id, a.newId));
    if (taken) throw new KernelError(`${plan.file.name} has already been created.`);

    // Each capability it adds to: one the admin can see, as the plan saw it, and only added to.
    const visible = new Set((await capabilitiesFor(tx, ctx)).map((c) => c.id));
    const versions = new Map<string, number>();
    for (const [id, e] of plan.edited) {
      const now = await getFile(tx, id);
      if (!now || !visible.has(id)) throw new KernelError("The plan changes an app you can't change.");
      if (!sameJson(now.file, e.before)) throw new KernelError(`${now.file.name} has changed since this plan was made. Reply to make the plan again.`);
      const taking = notAdditive(e.before, e.after);
      if (taking.length) throw new KernelError(taking[0]!, taking);
      versions.set(id, now.version);
    }

    const at = ctx.now ?? currentTime();
    // Every file is checked against the others as this change set leaves them: one part may read what another
    // adds (Customers adds up contracts by a link column that an Also change adds to them). It is one
    // transaction, so nothing is seen half done.
    const before = new Map<string, CapabilityFile>([...(await load(tx)).files].map(([id, f]) => [id, f.file]));
    const world = new Map(before);
    for (const [id, e] of plan.edited) world.set(id, e.after);
    world.set(a.newId, plan.file);
    // A typed column an Also change turns into a link (M27): its rows are moved last, once everything is saved.
    const moves = [...plan.edited].flatMap(([id, e]) => movesOf(id, e.before, e.after));
    const opts = { source: a.source ?? "plan", kind: moves.length ? ("restructure" as const) : ("add" as const), chatId: a.chatId, at, others: world };
    const changeSetId = await newChangeSet(tx, ctx, opts, [
      { capabilityId: a.newId, fromVersion: 0, toVersion: 1 },
      ...[...versions].map(([capabilityId, v]) => ({ capabilityId, fromVersion: v, toVersion: v + 1 })),
    ]);
    const save = async (id: string, e: { after: CapabilityFile }) => {
      await saveVersion(tx, ctx, id, e.after, { ...opts, changeSetId, event: "changeset.applied", details: { changes: (a.changes.get(id) ?? []).join("; ") } });
      await fillNewComputed(tx, ctx, id, plan.edited.get(id)!.before, e.after);
    };
    // What the new capability needs comes first (a step its rules move rows to); what reads the new
    // capability (a total of its rows) comes after it.
    const later = [...plan.edited].filter(([, e]) => references(e.after, a.newId));
    for (const [id, e] of plan.edited) if (!later.some(([l]) => l === id)) await save(id, e);
    await createCapability(tx, ctx, plan.file, { ...opts, changeSetId, id: a.newId });
    for (const [id, e] of later) await save(id, e);

    for (const im of a.imports ?? [])
      if (im.rows.length || im.gaps?.rows.length)
        await importRows(tx, ctx, a.newId, im.sheetId, im.rows, { source: im.fileName, at, changeSetId, chatId: a.chatId, gaps: im.gaps, history: a.source === "build" });
    if (moves.length) await applyMoves(tx, ctx, { before, after: world }, moves, { changeSetId, chatId: a.chatId, at });
    // "I'll email you when it's ready" (5h): sent once this commits.
    if (a.email !== false) await tx.insert(outbox).values({ workspaceId: ctx.workspaceId, personId: ctx.actor.id, kind: "ready", payload: { capabilityId: a.newId, capability: plan.file.name }, createdAt: at });
    return { capabilityId: a.newId, changeSetId };
  });
}

// A stored computed column an Also change adds (Spent), or whose formula a change rewrites (Left counting the leave
// entries, M29), is worked out for the rows already there, in the same transaction. The rows keep the file version
// they were written under.
export async function fillNewComputed(tx: Tx, ctx: KernelCtx, capId: string, before: CapabilityFile, after: CapabilityFile) {
  const w = await startWork(tx, ctx);
  const cap = w.loaded.files.get(capId)!;
  for (const sheet of after.sheets) {
    const was = before.sheets.find((s) => s.id === sheet.id);
    const added = sheet.columns.filter((c) => {
      if (c.type !== "computed" || !c.expr || !stored(sheet, c)) return false;
      const old = was?.columns.find((x) => x.id === c.id);
      return !old || JSON.stringify(old.expr) !== JSON.stringify(c.expr);
    });
    if (!added.length) continue;
    const live = await tx.select({ id: rows.id, data: rows.data }).from(rows).where(and(eq(rows.capabilityId, capId), eq(rows.sheetId, sheet.id), isNull(rows.deletedAt)));
    for (const r of live) {
      const data = await computeStored(w, cap, sheet as Sheet, r.id, r.data as Record<string, unknown>);
      await tx.update(rows).set({ data }).where(eq(rows.id, r.id));
    }
  }
}
