import { and, eq, isNull, sql } from "drizzle-orm";
import { rows } from "@/db/schema";
import { holds } from "./holds";
import { KernelError, type Work } from "./context";
import { LIMITS } from "./schema/validate";
import type { Sheet } from "./schema/file";

// Trees (0.5, M28): rows of one sheet that sit under each other through a link to the same sheet (cost centres,
// categories, classes → sections). The kernel keeps them a tree: no row under itself or under a row below it, at
// most LIMITS.treeDepth levels, and no row deleted while rows sit under it.

type Data = Record<string, unknown>;
type Title = (data: Data) => Promise<string>;

// The column naming the row above, on a tree sheet.
export const parentColumn = (sheet: Sheet): string | null => (sheet.kind === "tree" && sheet.tree ? sheet.tree.parent : null);

const words = (sheet: Sheet) => sheet.row ?? { one: "row", many: "rows" };

// The rows above a row, nearest first, as stored (a loop already there stops the walk).
async function above(w: Work, sheet: Sheet, capId: string, parent: string, from: string): Promise<{ id: string; data: Data }[]> {
  const found = await w.tx.execute<{ id: string; data: Data; n: number }>(sql`
    with recursive up(id, data, n) as (
      select ${rows.id}, ${rows.data}, 1 from ${rows}
       where ${rows.id} = ${from} and ${rows.capabilityId} = ${capId} and ${rows.sheetId} = ${sheet.id} and ${rows.deletedAt} is null
      union all
      select r.id, r.data, up.n + 1 from ${rows} r join up on r.id::text = up.data->>${parent}
       where r.capability_id = ${capId} and r.sheet_id = ${sheet.id} and r.deleted_at is null and up.n <= ${LIMITS.treeDepth}
    )
    select id, data, n from up order by n`);
  return [...found].map((r) => ({ id: r.id, data: r.data }));
}

// How many levels sit under a row (0 for a row with nothing under it).
async function heightUnder(w: Work, sheet: Sheet, capId: string, parent: string, rowId: string): Promise<number> {
  const found = await w.tx.execute<{ n: number }>(sql`
    with recursive down(id, n) as (
      select ${rowId}::uuid, 0
      union all
      select r.id, down.n + 1 from ${rows} r join down on r.data->>${parent} = down.id::text
       where r.capability_id = ${capId} and r.sheet_id = ${sheet.id} and r.deleted_at is null and down.n <= ${LIMITS.treeDepth}
    )
    select coalesce(max(n), 0)::int as n from down`);
  return Number([...found][0]?.n ?? 0);
}

// Before a row is saved with a new row above it: refused if it would sit under itself or under a row below it,
// or go deeper than the limit (with everything under it).
export async function checkPlace(w: Work, capId: string, sheet: Sheet, rowId: string | null, data: Data, title: Title) {
  const parent = parentColumn(sheet);
  const to = parent ? data[parent] : null;
  if (!parent || typeof to !== "string") return;
  const { one, many } = words(sheet);
  if (to === rowId) throw new KernelError(`A ${one} can't sit under itself.`);
  const chain = await above(w, sheet, capId, parent, to);
  const at = rowId ? chain.findIndex((r) => r.id === rowId) : -1;
  if (at >= 0) {
    const [target, self] = [chain[0]!, chain[at]!];
    throw new KernelError(`${await title(target.data)} sits under ${await title(self.data)}, so ${await title(self.data)} can't go under it.`);
  }
  const levels = chain.length + 1 + (rowId ? await heightUnder(w, sheet, capId, parent, rowId) : 0);
  if (levels > LIMITS.treeDepth) throw new KernelError(`${cap(many)} go at most ${LIMITS.treeDepth} levels deep.`);
}

// Before rows are deleted: refused while rows that aren't being deleted too sit under one of them.
export async function checkNothingUnder(w: Work, capId: string, sheet: Sheet, rowId: string, data: Data, deleting: ReadonlySet<string>, title: Title) {
  const parent = parentColumn(sheet);
  if (!parent) return;
  const under = await w.tx
    .select({ id: rows.id })
    .from(rows)
    .where(and(eq(rows.capabilityId, capId), eq(rows.sheetId, sheet.id), isNull(rows.deletedAt), holds(parent, rowId)));
  const left = under.filter((r) => !deleting.has(r.id)).length;
  if (!left) return;
  const { one, many } = words(sheet);
  throw new KernelError(`${left} ${left === 1 ? `${one} sits` : `${many} sit`} under ${await title(data)}. Move ${left === 1 ? "it" : "them"} first.`);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// A tree's rows in the table's order: each row followed by the rows under it, depth first, siblings in the order they
// came. level is 0 at the top; branch says rows sit under it. A row whose row above isn't in the list (not visible to
// this person) shows at the top.
export function treeOrder<T extends { id: string; data: Data }>(list: T[], parent: string): (T & { level: number; branch: boolean })[] {
  const ids = new Set(list.map((r) => r.id));
  const under = new Map<string, T[]>();
  const tops: T[] = [];
  for (const r of list) {
    const p = r.data[parent];
    if (typeof p === "string" && ids.has(p) && p !== r.id) under.set(p, [...(under.get(p) ?? []), r]);
    else tops.push(r);
  }
  const out: (T & { level: number; branch: boolean })[] = [];
  const seen = new Set<string>();
  const visit = (r: T, level: number) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    out.push({ ...r, level, branch: (under.get(r.id)?.length ?? 0) > 0 });
    for (const c of under.get(r.id) ?? []) visit(c, level + 1);
  };
  for (const r of tops) visit(r, 0);
  // Rows caught in a loop (never saved by the kernel, but data is data) still show, at the top.
  for (const r of list) visit(r, 0);
  return out;
}
