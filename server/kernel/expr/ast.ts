import { z } from "zod";

// The kernel's small expression language: JSON, no code. Used by computed columns, defaults, step
// conditions (onlyWhen), rule conditions and, later, report filters.
//
//   literal           1, "Vacation", true, null      (money in cents, dates as YYYY-MM-DD)
//   { col: id }       a column of this row; with via, that column on the row a link column points at
//                     (one hop); with part, the from or to of a money range
//   { ref: "today" }  the workspace's date today
//   { ref: "row" }    the row itself, for a rule's field map to link back to it ("add three interviews"
//                     for this candidate)
//   { op, args }      an operation below
//   { sumOf }         a column added up over rows that point at this row (a document's lines,
//                     the allocations into or out of it, or rows that link to it), optionally only
//                     those at some steps (Spent: the Paid bills of a budget)
//   { lookup }        a column of the row in another sheet of this capability whose column matches one of
//                     this row's ("Left" in Balances, for the same person)
//   { balanceOf }     the balance of a ledger in this capability (M29): its entries' amounts added up, for the
//                     account this row is (a link to this sheet) or names in one of its columns (of: Who)
//   { inForce }       a column of the row of a dated sheet in this capability in force on a date (M30): the one
//                     with the latest From on or before this row's date column `on` (today when left out), for the
//                     key this row names in `is` (left out when the dated sheet keeps one series)

export const OPS = [
  "and", "or", "not",
  "eq", "ne", "gt", "gte", "lt", "lte", "in", "between", "empty",
  "add", "sub", "mul", "div",
  "days_until", "date_add", "workdays",
  "if", // if(condition, then, otherwise): Notice is 90 for Enterprise, 30 otherwise
] as const;
export type Op = (typeof OPS)[number];

export const DATE_UNITS = ["days", "months", "years"] as const;
export type DateUnit = (typeof DATE_UNITS)[number];

export type Literal = string | number | boolean | null;
export type SumOf = {
  capability?: string; // another capability's id; this one when left out
  sheet: string;
  column: string;
  // The link column that points at this row (allocations, or any rows that link here). Left out for a
  // document's lines.
  by?: string;
  steps?: string[]; // only rows at one of these steps
};
export type Lookup = { sheet: string; where: string; is: string; value: string };
export type BalanceOf = { sheet: string; of?: string }; // of left out: the ledger's account is a link to this row
export type InForce = { sheet: string; is?: string; on?: string; value: string };
export type ColRef = { col: string; via?: string; part?: "from" | "to" };
export type Ref = { ref: "today" | "row" };
export type Expr = Literal | ColRef | Ref | { op: Op; args: Expr[] } | { sumOf: SumOf } | { lookup: Lookup } | { balanceOf: BalanceOf } | { inForce: InForce };

const literal = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

export const exprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    literal,
    z.strictObject({ col: z.string().min(1), via: z.string().min(1).optional(), part: z.enum(["from", "to"]).optional() }),
    z.strictObject({ ref: z.enum(["today", "row"]) }),
    z.strictObject({ op: z.enum(OPS), args: z.array(exprSchema) }),
    z.strictObject({
      sumOf: z.strictObject({
        capability: z.string().optional(),
        sheet: z.string().min(1),
        column: z.string().min(1),
        by: z.string().optional(),
        steps: z.array(z.string().min(1)).min(1).optional(),
      }),
    }),
    z.strictObject({
      lookup: z.strictObject({ sheet: z.string().min(1), where: z.string().min(1), is: z.string().min(1), value: z.string().min(1) }),
    }),
    z.strictObject({ balanceOf: z.strictObject({ sheet: z.string().min(1), of: z.string().min(1).optional() }) }),
    z.strictObject({
      inForce: z.strictObject({ sheet: z.string().min(1), is: z.string().min(1).optional(), on: z.string().min(1).optional(), value: z.string().min(1) }),
    }),
  ]),
);

export const isCol = (e: Expr): e is ColRef => typeof e === "object" && e !== null && "col" in e;
export const isRef = (e: Expr): e is Ref => typeof e === "object" && e !== null && "ref" in e;
export const isOp = (e: Expr): e is { op: Op; args: Expr[] } => typeof e === "object" && e !== null && "op" in e;
export const isSumOf = (e: Expr): e is { sumOf: SumOf } => typeof e === "object" && e !== null && "sumOf" in e;
export const isLookup = (e: Expr): e is { lookup: Lookup } => typeof e === "object" && e !== null && "lookup" in e;
export const isBalanceOf = (e: Expr): e is { balanceOf: BalanceOf } => typeof e === "object" && e !== null && "balanceOf" in e;
export const isInForce = (e: Expr): e is { inForce: InForce } => typeof e === "object" && e !== null && "inForce" in e;

// Every node of an expression, depth first.
export function* walk(e: Expr): Generator<Expr> {
  yield e;
  if (isOp(e)) for (const a of e.args) yield* walk(a);
}

export const usesToday = (e: Expr) => [...walk(e)].some((n) => (isRef(n) && n.ref === "today") || (isOp(n) && n.op === "days_until"));
// Columns of this row an expression reads (a linked value reads its link column; a lookup, the column it matches on).
export const columnsUsed = (e: Expr) =>
  [...walk(e)].flatMap((n) =>
    isCol(n)
      ? [n.via ?? n.col]
      : isLookup(n)
        ? [n.lookup.is]
        : isBalanceOf(n) && n.balanceOf.of
          ? [n.balanceOf.of]
          : isInForce(n)
            ? [n.inForce.is, n.inForce.on].filter((x): x is string => !!x)
            : [],
  );
// Whether it reads other rows than this one, so it is worked out when read, never stored.
export const readsOtherRows = (e: Expr) => [...walk(e)].some((n) => isLookup(n) || isInForce(n) || (isCol(n) && !!n.via));
