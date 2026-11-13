import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { rows } from "@/db/schema";
import { computedInOrder, sum, withToday, workedOut } from "./compute";
import type { CurrentFile, Work } from "./context";
import { isBalanceOf, isCol, isInForce, isLookup, isSumOf, readsOtherRows, walk, type Expr } from "./expr/ast";
import { balanceOnRow } from "./ledger";
import { inForceOnRow } from "./dated";
import { evaluate, type Env } from "./expr/evaluate";
import type { Sheet } from "./schema/file";

// What an expression needs beyond the row itself, read before it is evaluated so the evaluator stays pure:
// values on the rows link columns point at, looked-up rows and sums. Rule conditions, field maps, checks and
// computed columns that read other rows all go through here.

type Data = Record<string, unknown>;

async function liveData(w: Work, id: unknown): Promise<Data | null> {
  if (typeof id !== "string") return null;
  const [r] = await w.tx.select({ data: rows.data }).from(rows).where(and(eq(rows.id, id), isNull(rows.deletedAt)));
  return (r?.data as Data | undefined) ?? null;
}

export async function envFor(w: Work, cap: CurrentFile, sheet: Sheet, rowId: string | null, data: Data, exprs: Expr[]): Promise<Env> {
  const linked = new Map<string, Data | null>();
  const looked = new Map<string, unknown>();
  const sums = new Map<string, number>();
  const balances = new Map<string, number>();
  const inForce = new Map<string, unknown>();
  for (const e of exprs) {
    for (const n of walk(e)) {
      if (isInForce(n)) inForce.set(JSON.stringify(n.inForce), await inForceOnRow(w, cap, n.inForce, data));
      if (isBalanceOf(n)) balances.set(JSON.stringify(n.balanceOf), await balanceOnRow(w, cap, n.balanceOf, rowId, data));
      if (isCol(n) && n.via && !linked.has(n.via)) linked.set(n.via, await liveData(w, data[n.via]));
      if (isSumOf(n) && rowId) sums.set(JSON.stringify(n.sumOf), await sum(w, cap.id, rowId, n.sumOf));
      if (isLookup(n)) {
        const l = n.lookup;
        const match = data[l.is];
        const [hit] =
          match === null || match === undefined
            ? []
            : await w.tx
                .select({ data: rows.data })
                .from(rows)
                .where(and(eq(rows.capabilityId, cap.id), eq(rows.sheetId, l.sheet), isNull(rows.deletedAt), sql`${rows.data}->>${l.where} = ${String(match)}`))
                .orderBy(asc(rows.seq))
                .limit(1);
        const other = cap.file.sheets.find((s) => s.id === l.sheet);
        // The looked-up row is read as it is read anywhere: with its own computed columns.
        const full = hit && other ? withToday(other, hit.data as Data, w.today) : null;
        looked.set(JSON.stringify(l), full?.[l.value] ?? null);
      }
    }
  }
  return {
    value: (c) => data[c],
    today: w.today,
    rowId,
    sumOf: (s) => sums.get(JSON.stringify(s)) ?? 0,
    linked: (via, c) => linked.get(via)?.[c] ?? null,
    lookup: (l) => looked.get(JSON.stringify(l)) ?? null,
    balanceOf: (b) => balances.get(JSON.stringify(b)) ?? 0,
    inForce: (f) => inForce.get(JSON.stringify(f)) ?? null,
  };
}

export async function evaluateOn(w: Work, cap: CurrentFile, sheet: Sheet, rowId: string | null, data: Data, e: Expr): Promise<unknown> {
  return evaluate(e, await envFor(w, cap, sheet, rowId, data, [e]));
}

// A row as read, in full: stored values, the computed columns that use today, and those that read other rows.
export async function withOtherRows(w: Work, cap: CurrentFile, sheet: Sheet, rowId: string | null, data: Data): Promise<Data> {
  // One pass in order, so a column worked out from today reads the other-rows columns before it (G3).
  const out = { ...data };
  const when = workedOut(sheet);
  for (const c of computedInOrder(sheet)) {
    if (when.get(c.id) === "stored") continue;
    const v = when.get(c.id) === "today" ? evaluate(c.expr!, { value: (col) => out[col], today: w.today }) : await evaluateOn(w, cap, sheet, rowId, out, c.expr!);
    if (typeof v === "number") out[c.id] = c.result === "money" || c.result === "days" ? Math.round(v) : v;
    else if (v !== null && v !== undefined) out[c.id] = v;
  }
  return out;
}
