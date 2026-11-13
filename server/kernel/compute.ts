import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { rows } from "@/db/schema";
import { KernelError, type CurrentFile, type Work } from "./context";
import { holds } from "./holds";
import { isBalanceOf, isSumOf, readsOtherRows, usesToday, walk, type SumOf } from "./expr/ast";
import { balanceOnRow, balanceReaders } from "./ledger";
import { evaluate } from "./expr/evaluate";
import { formatMoney } from "./expr/render";
import { formatNumber } from "@/lib/format";
import type { Column, Sheet } from "./schema/file";
import { LIMITS } from "./schema/validate";

// Computed columns, totals and open amounts, worked out in the write's transaction. A computed column that
// uses today is worked out when read instead (withToday), so it never goes stale.

type Data = Record<string, unknown>;
const MAX_DEPTH = 3;

// Computed columns in the order they can be worked out: a column comes after the ones it reads.
export function computedInOrder(sheet: Sheet): Column[] {
  const computed = sheet.columns.filter((c) => c.type === "computed" && c.expr);
  const out: Column[] = [];
  const seen = new Set<string>();
  const visit = (c: Column) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    for (const node of walk(c.expr!)) {
      const dep = typeof node === "object" && node !== null && "col" in node ? computed.find((d) => d.id === node.col) : undefined;
      if (dep) visit(dep);
    }
    out.push(c);
  };
  computed.forEach(visit);
  return out;
}

// When each computed column is worked out. Stored: in the write. Today: when read, as it uses today. Other: when read,
// with the database, as it reads other rows. A column is worked out no earlier than the columns it reads (G3: Overdue,
// which reads Owing and Due by now, is worked out when read too, after them).
export type WorkedOut = "stored" | "today" | "other";
const RANK: Record<WorkedOut, number> = { stored: 0, today: 1, other: 2 };
export function workedOut(sheet: Sheet): Map<string, WorkedOut> {
  const out = new Map<string, WorkedOut>();
  for (const c of computedInOrder(sheet)) {
    let when: WorkedOut = readsOtherRows(c.expr!) ? "other" : usesToday(c.expr!) ? "today" : "stored";
    for (const node of walk(c.expr!)) {
      const dep = typeof node === "object" && node !== null && "col" in node && !("via" in node && node.via) ? out.get(String(node.col)) : undefined;
      if (dep && RANK[dep] > RANK[when]) when = dep;
    }
    out.set(c.id, when);
  }
  return out;
}

// Stored: worked out in the write; the rest are worked out when read.
export const stored = (sheet: Sheet, c: Column) => workedOut(sheet).get(c.id) === "stored";

function round(c: Column, v: unknown): unknown {
  if (typeof v !== "number") return v ?? null;
  return c.result === "money" || c.result === "days" ? Math.round(v) : v;
}

// The rows a sumOf adds up, for one row.
export async function sum(w: Work, capId: string, rowId: string, s: SumOf): Promise<number> {
  const cap = s.capability ?? capId;
  const pointsHere = s.by ? holds(s.by, rowId) : eq(rows.parentRowId, rowId);
  const [r] = await w.tx
    .select({ total: sql<string>`coalesce(sum((${rows.data}->>${s.column})::numeric), 0)` })
    .from(rows)
    .where(and(eq(rows.capabilityId, cap), eq(rows.sheetId, s.sheet), isNull(rows.deletedAt), pointsHere, s.steps ? inArray(rows.stepId, s.steps) : undefined));
  return Number(r?.total ?? 0);
}

// Works out a row's stored computed columns from its other values.
export async function computeStored(w: Work, cap: CurrentFile, sheet: Sheet, rowId: string, data: Data): Promise<Data> {
  const out = { ...data };
  const when = workedOut(sheet);
  for (const c of computedInOrder(sheet)) {
    if (when.get(c.id) !== "stored") {
      delete out[c.id];
      continue;
    }
    const sums = new Map<string, number>();
    const balances = new Map<string, number>();
    for (const node of walk(c.expr!)) {
      if (isSumOf(node)) sums.set(JSON.stringify(node.sumOf), await sum(w, cap.id, rowId, node.sumOf));
      if (isBalanceOf(node)) balances.set(JSON.stringify(node.balanceOf), await balanceOnRow(w, cap, node.balanceOf, rowId, out));
    }
    const v = round(
      c,
      evaluate(c.expr!, {
        value: (col) => out[col],
        today: w.today,
        sumOf: (s) => sums.get(JSON.stringify(s)) ?? 0,
        balanceOf: (b) => balances.get(JSON.stringify(b)) ?? 0,
      }),
    );
    if (v === null) delete out[c.id];
    else out[c.id] = v;
  }
  return out;
}

// A row as read: its stored values plus the computed columns that depend on today. Those that read other rows
// are added by withOtherRows (env.ts), which needs the database.
export function withToday(sheet: Sheet, data: Data, today: string): Data {
  const out = { ...data };
  const when = workedOut(sheet);
  for (const c of computedInOrder(sheet)) {
    if (when.get(c.id) !== "today") continue;
    const v = round(c, evaluate(c.expr!, { value: (col) => out[col], today }));
    if (v !== null) out[c.id] = v;
  }
  return out;
}

// Sheets whose computed columns add up rows of (capId, sheetId): a document over its lines, a row over the
// allocations that point at it.
function dependents(w: Work, capId: string, sheetId: string) {
  const out: { cap: CurrentFile; sheet: Sheet; by?: string }[] = [];
  for (const cap of w.loaded.files.values()) {
    for (const sheet of cap.file.sheets) {
      const found = new Map<string, string | undefined>();
      for (const c of sheet.columns) {
        if (c.type !== "computed" || !c.expr) continue;
        for (const n of walk(c.expr)) if (isSumOf(n) && (n.sumOf.capability ?? cap.id) === capId && n.sumOf.sheet === sheetId) found.set(n.sumOf.by ?? "", n.sumOf.by);
      }
      for (const by of found.values()) out.push({ cap, sheet, by });
    }
  }
  return out;
}

// A tree's total that includes the rows under it: a sum over its own sheet through the row each sits under (M28).
const climbs = (dep: { cap: CurrentFile; sheet: Sheet; by?: string }, capId: string, sheetId: string) =>
  dep.cap.id === capId && dep.sheet.id === sheetId && dep.sheet.kind === "tree" && !!dep.by && dep.by === dep.sheet.tree?.parent;

// After a row changes (or is deleted): recompute the rows whose totals include it, then theirs, a few levels up.
// Climbing a tree to the row above doesn't count as a level: a tree's totals go all the way up (at most treeDepth).
export async function recomputeDependents(
  w: Work,
  capId: string,
  sheetId: string,
  row: { parentRowId: string | null; data: Data; oldData?: Data },
  depth = 0,
  climbed = 0,
): Promise<void> {
  if (depth >= MAX_DEPTH) return;
  for (const dep of dependents(w, capId, sheetId)) {
    const up = climbs(dep, capId, sheetId);
    if (up && climbed >= LIMITS.treeDepth) continue;
    const targets = dep.by ? [row.data[dep.by], row.oldData?.[dep.by]] : [row.parentRowId];
    for (const id of new Set(targets.filter((t): t is string => typeof t === "string"))) {
      const [target] = await w.tx
        .select({ data: rows.data, parentRowId: rows.parentRowId })
        .from(rows)
        .where(and(eq(rows.id, id), eq(rows.capabilityId, dep.cap.id), eq(rows.sheetId, dep.sheet.id), isNull(rows.deletedAt)))
        .for("update");
      if (!target) continue;
      const before = target.data as Data;
      const after = await computeStored(w, dep.cap, dep.sheet, id, before);
      if (JSON.stringify(after) === JSON.stringify(before)) continue;
      await w.tx.update(rows).set({ data: after, updatedAt: w.now }).where(eq(rows.id, id));
      await checkLimits(w, dep.cap, dep.sheet, id, after);
      const next = { parentRowId: target.parentRowId, data: after, oldData: before };
      await recomputeDependents(w, dep.cap.id, dep.sheet.id, next, up ? depth : depth + 1, up ? climbed + 1 : 0);
    }
  }
}

// After an entry is added to a ledger (M29): the rows showing its account's balance (an item's In stock, a person's
// Left) are worked out again in the same write, then the rows that total them.
export async function recomputeBalances(w: Work, cap: CurrentFile, ledger: Sheet, account: string): Promise<void> {
  for (const { sheet, id } of await balanceReaders(w, cap, ledger, account)) {
    const [target] = await w.tx.select({ data: rows.data, parentRowId: rows.parentRowId }).from(rows).where(eq(rows.id, id)).for("update");
    if (!target) continue;
    const before = target.data as Data;
    const after = await computeStored(w, cap, sheet, id, before);
    if (JSON.stringify(after) === JSON.stringify(before)) continue;
    await w.tx.update(rows).set({ data: after, updatedAt: w.now }).where(eq(rows.id, id));
    await checkLimits(w, cap, sheet, id, after);
    await recomputeDependents(w, cap.id, sheet.id, { parentRowId: target.parentRowId, data: after, oldData: before });
  }
}

function amountText(w: Work, column: Column | undefined, v: number) {
  return column?.type === "money" ? formatMoney(v, w.loaded.formats) : formatNumber(v, w.loaded.formats);
}

// Allocation sheets that allocate from or to rows of (capId, sheetId), with the column each may not go above.
function allocationsInto(w: Work, capId: string, sheetId: string) {
  const out: { cap: CurrentFile; sheet: Sheet; side: string; limit: string }[] = [];
  for (const cap of w.loaded.files.values()) {
    for (const sheet of cap.file.sheets) {
      const a = sheet.allocation;
      if (sheet.kind !== "allocation" || !a) continue;
      for (const [side, limit] of [[a.from, a.fromLimit], [a.to, a.toLimit]] as const) {
        const link = sheet.columns.find((c) => c.id === side)?.link;
        if (limit && link && (link.capability ?? cap.id) === capId && link.sheet === sheetId) out.push({ cap, sheet, side, limit });
      }
    }
  }
  return out;
}

async function allocated(w: Work, alloc: { cap: CurrentFile; sheet: Sheet; side: string }, targetId: string, exceptRowId?: string) {
  const amount = alloc.sheet.allocation!.amount;
  const [r] = await w.tx
    .select({ total: sql<string>`coalesce(sum((${rows.data}->>${amount})::numeric), 0)` })
    .from(rows)
    .where(
      and(
        eq(rows.capabilityId, alloc.cap.id),
        eq(rows.sheetId, alloc.sheet.id),
        isNull(rows.deletedAt),
        holds(alloc.side, targetId),
        exceptRowId ? ne(rows.id, exceptRowId) : undefined,
      ),
    );
  return Number(r?.total ?? 0);
}

// A row's amount can't drop below what is already allocated from or to it.
export async function checkLimits(w: Work, cap: CurrentFile, sheet: Sheet, rowId: string, data: Data) {
  for (const alloc of allocationsInto(w, cap.id, sheet.id)) {
    const limit = Number(data[alloc.limit] ?? 0);
    const used = await allocated(w, alloc, rowId);
    if (used > limit) {
      const col = sheet.columns.find((c) => c.id === alloc.limit);
      throw new KernelError(`${amountText(w, col, used)} is already allocated against ${col?.name ?? "this amount"}, more than its ${amountText(w, col, limit)}.`);
    }
  }
}

// An allocation row: never more than its source (or its target, when the sheet names a limit there).
// The rows on both sides are locked first, so two allocations made at once can't go over together.
export async function checkAllocation(w: Work, cap: CurrentFile, sheet: Sheet, data: Data, rowId?: string) {
  const a = sheet.allocation!;
  const amountCol = sheet.columns.find((c) => c.id === a.amount);
  const amount = Number(data[a.amount] ?? 0);
  if (amount < 0) throw new KernelError(`${amountCol?.name ?? "The amount"} can't be below zero.`);
  for (const [side, limitCol] of [[a.from, a.fromLimit], [a.to, a.toLimit]] as const) {
    if (!limitCol) continue;
    const link = sheet.columns.find((c) => c.id === side)!.link!;
    const targetId = data[side];
    if (typeof targetId !== "string") continue;
    const [target] = await w.tx
      .select({ data: rows.data })
      .from(rows)
      .where(and(eq(rows.id, targetId), eq(rows.capabilityId, link.capability ?? cap.id), isNull(rows.deletedAt)))
      .for("update");
    if (!target) continue;
    const limit = Number((target.data as Data)[limitCol] ?? 0);
    const total = (await allocated(w, { cap, sheet, side }, targetId, rowId)) + amount;
    if (total > limit) {
      const sideName = sheet.columns.find((c) => c.id === side)?.name ?? "it";
      throw new KernelError(
        `That allocates ${amountText(w, amountCol, total)} against this ${sideName.toLowerCase()}, more than its ${amountText(w, amountCol, limit)}.`,
      );
    }
  }
}
