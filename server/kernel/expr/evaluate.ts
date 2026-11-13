import { isBalanceOf, isCol, isInForce, isLookup, isOp, isRef, isSumOf, type BalanceOf, type DateUnit, type Expr, type InForce, type Lookup, type SumOf } from "./ast";

// Pure and deterministic: the same expression, row and date always give the same value.
// An empty value (null) never matches a comparison and makes arithmetic empty.

export type Env = {
  value(col: string): unknown; // the stored value of a column on this row
  today: string; // YYYY-MM-DD in the workspace's time zone
  rowId?: string | null; // the row itself ({ ref: "row" })
  sumOf?(s: SumOf): number;
  linked?(via: string, col: string): unknown; // a column on the row a link column points at
  lookup?(l: Lookup): unknown;
  balanceOf?(b: BalanceOf): number; // a ledger's balance for this row's account (M29)
  inForce?(f: InForce): unknown; // a column of a dated sheet's row in force on a date (M30)
};

const DAY = 86_400_000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

const toTime = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fromTime = (t: number) => new Date(t).toISOString().slice(0, 10);

export function addToDate(date: string, n: number, unit: DateUnit): string {
  if (unit === "days") return fromTime(toTime(date) + n * DAY);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const months = (unit === "years" ? 12 : 1) * n;
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  // Clamp to the month's last day: Jan 31 + 1 month is Feb 28.
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return fromTime(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last)));
}

// Monday to Friday from one date to another, both included.
export function workdays(from: string, to: string): number {
  let n = 0;
  for (let t = toTime(from); t <= toTime(to); t += DAY) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
const isDate = (v: unknown): v is string => typeof v === "string" && ISO.test(v);

function compare(a: unknown, b: unknown): number | null {
  if (isEmpty(a) || isEmpty(b)) return null;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0; // dates sort as text
  return null;
}

export function evaluate(e: Expr, env: Env): unknown {
  if (e === null || typeof e !== "object") return e;
  if (isRef(e)) return e.ref === "row" ? (env.rowId ?? null) : env.today;
  if (isCol(e)) {
    const v = e.via ? env.linked?.(e.via, e.col) : env.value(e.col);
    if (e.part) return v && typeof v === "object" && e.part in v ? ((v as Record<string, unknown>)[e.part] ?? null) : null;
    return v === undefined ? null : v;
  }
  if (isSumOf(e)) return env.sumOf ? env.sumOf(e.sumOf) : 0;
  if (isLookup(e)) return env.lookup?.(e.lookup) ?? null;
  if (isBalanceOf(e)) return env.balanceOf ? env.balanceOf(e.balanceOf) : 0;
  if (isInForce(e)) return env.inForce?.(e.inForce) ?? null;
  if (!isOp(e)) return null;

  const arg = (i: number) => evaluate(e.args[i]!, env);
  const num = (i: number) => {
    const v = arg(i);
    return typeof v === "number" ? v : null;
  };

  switch (e.op) {
    case "and": return e.args.every((_, i) => arg(i) === true);
    case "or": return e.args.some((_, i) => arg(i) === true);
    case "not": return arg(0) !== true;
    case "eq": {
      const [a, b] = [arg(0), arg(1)];
      return isEmpty(a) && isEmpty(b) ? true : a === b;
    }
    case "ne": {
      const [a, b] = [arg(0), arg(1)];
      return isEmpty(a) && isEmpty(b) ? false : a !== b;
    }
    case "gt": { const c = compare(arg(0), arg(1)); return c !== null && c > 0; }
    case "gte": { const c = compare(arg(0), arg(1)); return c !== null && c >= 0; }
    case "lt": { const c = compare(arg(0), arg(1)); return c !== null && c < 0; }
    case "lte": { const c = compare(arg(0), arg(1)); return c !== null && c <= 0; }
    case "between": {
      const [lo, hi] = [compare(arg(0), arg(1)), compare(arg(0), arg(2))];
      return lo !== null && hi !== null && lo >= 0 && hi <= 0;
    }
    case "in": {
      const v = arg(0);
      return !isEmpty(v) && e.args.slice(1).some((a) => a === v);
    }
    case "empty": return isEmpty(arg(0));
    case "add": { const [a, b] = [num(0), num(1)]; return a === null || b === null ? null : a + b; }
    case "mul": { const [a, b] = [num(0), num(1)]; return a === null || b === null ? null : a * b; }
    case "div": { const [a, b] = [num(0), num(1)]; return a === null || b === null || b === 0 ? null : a / b; }
    case "sub": {
      const [a, b] = [arg(0), arg(1)];
      if (isDate(a) && isDate(b)) return Math.round((toTime(a) - toTime(b)) / DAY);
      return typeof a === "number" && typeof b === "number" ? a - b : null;
    }
    case "days_until": {
      const d = arg(0);
      return isDate(d) ? Math.round((toTime(d) - toTime(env.today)) / DAY) : null;
    }
    case "date_add": {
      const [d, n, unit] = [arg(0), num(1), arg(2)];
      return isDate(d) && n !== null ? addToDate(d, n, unit as DateUnit) : null;
    }
    case "workdays": {
      const [a, b] = [arg(0), arg(1)];
      return isDate(a) && isDate(b) ? workdays(a, b) : null;
    }
    case "if": return arg(0) === true ? arg(1) : arg(2);
  }
}
