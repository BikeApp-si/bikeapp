import type { Column } from "../schema/file";
import { formatDate, formatMoney, formatNumber, type Formats } from "@/lib/format";
import { isBalanceOf, isCol, isInForce, isLookup, isOp, isRef, isSumOf, type Expr } from "./ast";

export { formatDate, formatMoney };

// An expression in plain words, for the Customize text. Fixed templates, no AI: the same expression
// always reads the same.

export type RenderCtx = {
  column(id: string): Column | undefined;
  // Names for a sumOf: the sheet and the column added up.
  otherColumn(sheet: string, column: string, capability?: string): { sheet: string; column: string };
  // A step's name in another sheet, for a sum at some steps.
  otherStep?(sheet: string, step: string, capability?: string): string | undefined;
  personName?(id: string): string | undefined;
  // A column on the row a link column points at ("Hiring manager" of the Opening).
  linkedColumn?(via: string, col: string): Column | undefined;
  formats?: Formats; // the company's money, numbers and dates; dollars when left out
};

const plural = (n: number, one: string) => `${n} ${one}${Math.abs(n) === 1 ? "" : "s"}`;

// like: the column a value on its own belongs to (a default), so a choice reads by its name, not its id (E1).
export function renderExpr(e: Expr, ctx: RenderCtx, like?: Column): string {
  // A literal reads in the terms of the column it is compared with.
  function value(v: Expr, like?: Column): string {
    if (v === null) return "empty";
    if (typeof v === "boolean") return v ? "yes" : "no";
    if (typeof v === "number") {
      switch (like?.type) {
        case "money": return formatMoney(v, ctx.formats);
        case "days": return plural(v, "day");
        case "percent": return `${v}%`;
        default: return formatNumber(v, ctx.formats);
      }
    }
    if (typeof v === "string") {
      if (like?.type === "choice") return like.options?.find((o) => o.id === v)?.name ?? v;
      if (like?.type === "person") return ctx.personName?.(v) ?? v;
      if (like?.type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return formatDate(v, ctx.formats);
      return v;
    }
    return go(v);
  }

  const colOf = (x: Expr | undefined) => {
    if (x === undefined || !isCol(x)) return undefined;
    const c = x.via ? ctx.linkedColumn?.(x.via, x.col) : ctx.column(x.col);
    return x.part && c?.type === "money_range" ? ({ ...c, type: "money" } as Column) : c;
  };

  function go(e: Expr): string {
    if (e === null || typeof e !== "object") return value(e);
    if (isRef(e)) return e.ref === "row" ? "this row" : "today";
    if (isCol(e)) {
      const name = e.via
        ? `the ${ctx.linkedColumn?.(e.via, e.col)?.name ?? e.col} of the ${ctx.column(e.via)?.name ?? e.via}`
        : (ctx.column(e.col)?.name ?? e.col);
      return e.part ? `the ${e.part === "from" ? "bottom" : "top"} of ${name.replace(/^the /, "")}` : name;
    }
    if (isLookup(e)) {
      const names = ctx.otherColumn(e.lookup.sheet, e.lookup.value);
      return `${names.column} in ${names.sheet} for the same ${ctx.column(e.lookup.is)?.name ?? e.lookup.is}`;
    }
    // "the Limit in Spending limits for the same Category, in force on Date" (M30).
    if (isInForce(e)) {
      const f = e.inForce;
      const names = ctx.otherColumn(f.sheet, f.value);
      const same = f.is ? ` for the same ${ctx.column(f.is)?.name ?? f.is}` : "";
      return `the ${names.column} in ${names.sheet}${same}, in force ${f.on ? `on ${ctx.column(f.on)?.name ?? f.on}` : "today"}`;
    }
    if (isBalanceOf(e)) {
      const ledger = ctx.otherColumn(e.balanceOf.sheet, "").sheet;
      return e.balanceOf.of ? `the ${ctx.column(e.balanceOf.of)?.name ?? e.balanceOf.of}'s ${ledger.toLowerCase()} added up` : `its ${ledger.toLowerCase()} added up`;
    }
    if (isSumOf(e)) {
      const names = ctx.otherColumn(e.sumOf.sheet, e.sumOf.column, e.sumOf.capability);
      const steps = (e.sumOf.steps ?? []).map((id) => ctx.otherStep?.(e.sumOf.sheet, id, e.sumOf.capability) ?? id);
      return `the total of ${names.column} in ${names.sheet}${steps.length ? ` at ${steps.join(" or ")}` : ""}`;
    }
    if (!isOp(e)) return "";
    const [a, b, c] = e.args;
    const like = colOf(a) ?? colOf(b);
    const pair = (word: string) => `${go(a!)} ${word} ${value(b!, like)}`;
    switch (e.op) {
      case "and": return e.args.map(go).join(" and ");
      case "or": return e.args.map(go).join(" or ");
      case "not": return `not ${go(a!)}`;
      case "eq": return b === null ? `${go(a!)} is empty` : pair("is");
      case "ne": return b === null ? `${go(a!)} isn't empty` : pair("isn't");
      case "gt": return pair("over");
      case "gte": return pair("at least");
      case "lt": return pair("under");
      case "lte": return pair("at most");
      case "between": return `${go(a!)} between ${value(b!, like)} and ${value(c!, like)}`;
      case "in": {
        const opts = e.args.slice(1).map((x) => value(x, like));
        return `${go(a!)} is ${opts.length > 1 ? `${opts.slice(0, -1).join(", ")} or ${opts.at(-1)}` : opts[0]}`;
      }
      case "empty": return `${go(a!)} is empty`;
      case "add": return `${go(a!)} + ${value(b!, like)}`;
      case "sub": return `${go(a!)} − ${value(b!, like)}`;
      case "mul": return `${go(a!)} × ${value(b!)}`;
      case "div": return `${go(a!)} ÷ ${value(b!)}`;
      case "days_until": return `days until ${go(a!)}`;
      case "workdays": return `workdays from ${go(a!)} to ${go(b!)}`;
      case "if": {
        // "90 for Enterprise, 30 for Standard" when it picks between the two options of a choice column.
        const on = isOp(a!) && a.op === "eq" ? a.args : [];
        const choice = colOf(on[0]);
        const other = choice?.type === "choice" && choice.options?.length === 2 ? choice.options.find((o) => o.id !== on[1]) : undefined;
        if (choice && other) return `${value(b!)} for ${value(on[1]!, choice)}, ${value(c!)} for ${other.name}`;
        return `${value(b!)} if ${go(a!)}, otherwise ${value(c!)}`;
      }
      case "date_add": {
        const n = typeof b === "number" ? b : 0;
        const unit = String(c).replace(/s$/, "");
        return `${go(a!)} ${n < 0 ? "−" : "+"} ${plural(Math.abs(n), unit)}`;
      }
    }
  }

  return e !== null && typeof e === "object" ? go(e) : value(e, like?.type === "choice" || like?.type === "person" ? like : undefined);
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

// The hint under a form field whose default is worked out (7c): "Leave empty for one year after Start."
export function renderDefaultHint(e: Expr, ctx: RenderCtx): string {
  const [from, n, unitArg] = isOp(e) && e.op === "date_add" ? e.args : [];
  if (from !== undefined && isCol(from) && typeof n === "number" && typeof unitArg === "string") {
    const unit = unitArg.replace(/s$/, "");
    const count = Math.abs(n) <= 10 ? WORDS[Math.abs(n)]! : String(Math.abs(n));
    const col = ctx.column(from.col)?.name ?? from.col;
    return `Leave empty for ${count} ${unit}${Math.abs(n) === 1 ? "" : "s"} ${n < 0 ? "before" : "after"} ${col}.`;
  }
  return `Leave empty for ${renderExpr(e, ctx)}.`;
}
