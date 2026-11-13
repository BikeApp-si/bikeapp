import { and, asc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { savedViews, tablePrefs } from "@/db/schema";
import { accessTo, type Access } from "./access";
import { record } from "./audit";
import { currentTime } from "./clock";
import { AccessError, KernelError, load, type KernelCtx } from "./context";
import { filterSql, groupable, orderSql, type Filter, type GroupBy, type Sort } from "./query";
import type { Sheet } from "./schema/file";
import type { Tx } from "./tx";

// Saved views of a sheet and how each person arranges its table (0.4, M19). A view is filters, sort and columns under
// a name: a person's own, or shared by an admin of the capability with everyone who can see the sheet. Opening one runs
// its filters through the ordinary read, so it never shows a row the person couldn't see anyway.

export type ViewColumns = { order: string[]; hidden: string[] };
export type Layout = "table" | "board";
export type TableColumns = ViewColumns & { widths: Record<string, number>; frozen: boolean; layout?: Layout; groupBy?: GroupBy | null };
export type SavedView = { id: string; name: string; shared: boolean; mine: boolean; filters: Filter[]; sort: Sort | null; columns: ViewColumns | null; layout: Layout; groupBy: GroupBy | null };

const filterInput = z.union([
  z.object({ column: z.string(), op: z.literal("in"), values: z.array(z.string()) }),
  z.object({ column: z.string(), op: z.literal("contains"), text: z.string() }),
  z.object({ column: z.string(), op: z.literal("between"), from: z.union([z.number(), z.string()]).nullable().optional(), to: z.union([z.number(), z.string()]).nullable().optional() }),
]);
const viewInput = z.object({
  name: z.string().trim().min(1, "Give the view a name.").max(60, "Keep the view's name under 60 characters."),
  filters: z.array(filterInput).max(20),
  sort: z.object({ column: z.string(), dir: z.enum(["asc", "desc"]) }).nullable(),
  columns: z.object({ order: z.array(z.string()), hidden: z.array(z.string()) }).nullable(),
  shared: z.boolean(),
  layout: z.enum(["table", "board"]).default("table"),
  groupBy: z.object({ column: z.string(), by: z.enum(["team", "month"]).optional() }).nullable().default(null),
});
export type ViewInput = z.input<typeof viewInput>;

const NO_SHEET = "That sheet doesn't exist, or you can't see it.";
const NO_VIEW = "That view doesn't exist, or you can't change it.";

async function sheetFor(tx: Tx, ctx: KernelCtx, capId: string, sheetId: string): Promise<{ access: Access; sheet: Sheet }> {
  const access = await accessTo(tx, await load(tx), capId, ctx.actor.id);
  const sheet = access?.cap.file.sheets.find((s) => s.id === sheetId);
  if (!access || !sheet || !access.can("see", sheetId)) throw new AccessError(NO_SHEET);
  return { access, sheet };
}

// Every name a view uses must be one of the sheet's columns, and its filters and sort must be ones the table can run.
function checkView(sheet: Sheet, v: Pick<ViewInput, "filters" | "sort" | "columns" | "layout" | "groupBy">) {
  filterSql(sheet, v.filters);
  if (v.layout === "board" && !sheet.steps?.length) throw new KernelError(`${sheet.name} has no steps, so it can't be shown as a board.`);
  if (v.groupBy && !groupable(sheet, v.groupBy)) throw new KernelError(`${sheet.name}'s rows can't be grouped that way.`);
  if (v.sort) orderSql(sheet, v.sort, () => null);
  const ids = new Set(sheet.columns.map((c) => c.id));
  for (const id of [...(v.columns?.order ?? []), ...(v.columns?.hidden ?? [])]) if (!ids.has(id)) throw new KernelError(`${sheet.name} has no such column.`);
}

const toView = (personId: string) => (r: typeof savedViews.$inferSelect): SavedView => ({
  id: r.id,
  name: r.name,
  shared: r.ownerId === null,
  mine: r.ownerId === personId,
  filters: r.filters as Filter[],
  sort: (r.sort as Sort | null) ?? null,
  columns: (r.columns as ViewColumns | null) ?? null,
  layout: r.layout === "board" ? "board" : "table",
  groupBy: (r.groupBy as GroupBy | null) ?? null,
});

// The sheet's shared views, then the person's own, each in the order they were made.
export async function viewsFor(tx: Tx, ctx: KernelCtx, capId: string, sheetId: string): Promise<SavedView[]> {
  await sheetFor(tx, ctx, capId, sheetId);
  const rows = await tx
    .select()
    .from(savedViews)
    .where(and(eq(savedViews.capabilityId, capId), eq(savedViews.sheetId, sheetId), or(isNull(savedViews.ownerId), eq(savedViews.ownerId, ctx.actor.id))))
    .orderBy(asc(savedViews.position), asc(savedViews.createdAt));
  const all = rows.map(toView(ctx.actor.id));
  return [...all.filter((v) => v.shared), ...all.filter((v) => !v.shared)];
}

// A new view, or a change to one: a person changes their own; a shared one is made, changed or unshared only by an
// admin of the capability (who can Customize it), and that is in the Audit log.
export async function saveView(tx: Tx, ctx: KernelCtx, capId: string, sheetId: string, input: ViewInput, id?: string): Promise<SavedView> {
  const parsed = viewInput.safeParse(input);
  if (!parsed.success) throw new KernelError(parsed.error.issues[0]!.message);
  const v = parsed.data;
  const { access, sheet } = await sheetFor(tx, ctx, capId, sheetId);
  checkView(sheet, v);
  const admin = access.can("customize", sheetId);
  if (v.shared && !admin) throw new AccessError("Only an admin of this app can share a view.");
  const now = ctx.now ?? currentTime();
  const values = { name: v.name, filters: v.filters, sort: v.sort, columns: v.columns, layout: v.layout, groupBy: v.groupBy, ownerId: v.shared ? null : ctx.actor.id, updatedAt: now };
  let row: typeof savedViews.$inferSelect;
  if (id) {
    const [was] = await tx.select().from(savedViews).where(and(eq(savedViews.id, id), eq(savedViews.capabilityId, capId), eq(savedViews.sheetId, sheetId)));
    if (!was || (was.ownerId === null ? !admin : was.ownerId !== ctx.actor.id)) throw new AccessError(NO_VIEW);
    [row] = (await tx.update(savedViews).set(values).where(eq(savedViews.id, id)).returning()) as [typeof savedViews.$inferSelect];
    if (was.ownerId === null || v.shared) await record(tx, ctx, { who: ctx.actor.email, capabilityId: capId, event: "view.saved", details: { sheet: sheet.name, view: v.name, shared: v.shared } });
  } else {
    [row] = (await tx
      .insert(savedViews)
      .values({ workspaceId: ctx.workspaceId, capabilityId: capId, sheetId, createdBy: ctx.actor.id, createdAt: now, ...values })
      .returning()) as [typeof savedViews.$inferSelect];
    if (v.shared) await record(tx, ctx, { who: ctx.actor.email, capabilityId: capId, event: "view.saved", details: { sheet: sheet.name, view: v.name, shared: true } });
  }
  return toView(ctx.actor.id)(row);
}

export async function deleteView(tx: Tx, ctx: KernelCtx, id: string): Promise<void> {
  const [was] = await tx.select().from(savedViews).where(eq(savedViews.id, id));
  if (!was) throw new AccessError(NO_VIEW);
  const { access, sheet } = await sheetFor(tx, ctx, was.capabilityId, was.sheetId).catch(() => {
    throw new AccessError(NO_VIEW);
  });
  if (was.ownerId === null ? !access.can("customize", was.sheetId) : was.ownerId !== ctx.actor.id) throw new AccessError(NO_VIEW);
  await tx.delete(savedViews).where(eq(savedViews.id, id));
  if (was.ownerId === null) await record(tx, ctx, { who: ctx.actor.email, capabilityId: was.capabilityId, event: "view.removed", details: { sheet: sheet.name, view: was.name } });
}

// How this person arranges the sheet's table; null until they change it.
export async function tablePrefsFor(tx: Tx, ctx: KernelCtx, capId: string, sheetId: string): Promise<TableColumns | null> {
  await sheetFor(tx, ctx, capId, sheetId);
  const [row] = await tx
    .select({ columns: tablePrefs.columns })
    .from(tablePrefs)
    .where(and(eq(tablePrefs.personId, ctx.actor.id), eq(tablePrefs.capabilityId, capId), eq(tablePrefs.sheetId, sheetId)));
  return (row?.columns as TableColumns | undefined) ?? null;
}

const prefsInput = z.object({
  order: z.array(z.string()),
  hidden: z.array(z.string()),
  widths: z.record(z.string(), z.number().int().min(60).max(800)),
  frozen: z.boolean(),
  layout: z.enum(["table", "board"]).optional(),
  groupBy: z.object({ column: z.string(), by: z.enum(["team", "month"]).optional() }).nullable().optional(),
});

export async function saveTablePrefs(tx: Tx, ctx: KernelCtx, capId: string, sheetId: string, columns: TableColumns | null): Promise<void> {
  const { sheet } = await sheetFor(tx, ctx, capId, sheetId);
  const mine = and(eq(tablePrefs.personId, ctx.actor.id), eq(tablePrefs.capabilityId, capId), eq(tablePrefs.sheetId, sheetId));
  if (!columns) return void (await tx.delete(tablePrefs).where(mine));
  const parsed = prefsInput.safeParse(columns);
  if (!parsed.success) throw new KernelError("Those column settings can't be saved.");
  checkView(sheet, { filters: [], sort: null, columns: parsed.data, layout: parsed.data.layout, groupBy: parsed.data.groupBy ?? null });
  const now = ctx.now ?? currentTime();
  await tx
    .insert(tablePrefs)
    .values({ workspaceId: ctx.workspaceId, personId: ctx.actor.id, capabilityId: capId, sheetId, columns: parsed.data, updatedAt: now })
    .onConflictDoUpdate({ target: [tablePrefs.workspaceId, tablePrefs.personId, tablePrefs.capabilityId, tablePrefs.sheetId], set: { columns: parsed.data, updatedAt: now } });
}
