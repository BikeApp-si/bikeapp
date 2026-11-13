import type { ColumnType } from "../schema/file";
import { DATE_UNITS, isBalanceOf, isCol, isInForce, isLookup, isOp, isRef, isSumOf, type BalanceOf, type Expr, type InForce, type Lookup, type SumOf } from "./ast";

// What a value is, as far as an expression cares.
export type Kind = "num" | "date" | "datetime" | "text" | "bool" | "range" | "null" | "any";
const KINDS: readonly string[] = ["num", "date", "datetime", "text", "bool", "range", "null", "any"];

export function kindOfColumn(type: ColumnType | "computed", result?: string): Kind {
  switch (type) {
    case "number": case "money": case "percent": case "days": return "num";
    case "date": return "date";
    case "datetime": return "datetime";
    case "money_range": return "range";
    case "computed": return result === "date" ? "date" : result === "text" ? "text" : "num";
    default: return "text"; // text, long_text, email, phone, url, person, choice, step, link, file
  }
}

export type Scope = {
  // The kind of a column on this row, or null when there is no such column.
  column(id: string): Kind | null;
  // Checks a sumOf; returns a plain-words error or null.
  sumOf(s: SumOf): string | null;
  // The kind of a column on the row a link column points at, or a plain-words error.
  linked?(via: string, col: string): Kind | string;
  // The kind of the looked-up column, or a plain-words error.
  lookup?(l: Lookup): Kind | string;
  // Checks a ledger's balance (M29); returns a plain-words error or null.
  balanceOf?(b: BalanceOf): string | null;
  // The kind of the column read from a dated sheet's row in force (M30), or a plain-words error.
  inForce?(f: InForce): Kind | string;
};

const fits = (a: Kind, b: Kind) => a === b || a === "any" || b === "any" || a === "null" || b === "null";

// Checks an expression against the columns it can see. Returns its kind and every problem, in plain words.
export function checkExpr(e: Expr, scope: Scope): { kind: Kind; errors: string[] } {
  const errors: string[] = [];

  function go(e: Expr): Kind {
    if (e === null) return "null";
    if (typeof e === "number") return "num";
    if (typeof e === "boolean") return "bool";
    if (typeof e === "string") return "text";
    if (isRef(e)) return e.ref === "row" ? "text" : "date";
    if (isCol(e)) {
      let k: Kind | null;
      if (e.via) {
        const got = scope.linked ? scope.linked(e.via, e.col) : `There is no link column “${e.via}”.`;
        if (!KINDS.includes(got)) {
          errors.push(got);
          return "any";
        }
        k = got as Kind;
      } else {
        k = scope.column(e.col);
        if (!k) errors.push(`There is no column “${e.col}”.`);
      }
      if (e.part) {
        if (k && k !== "range" && k !== "any") errors.push(`Only a money range has a from and a to.`);
        return "num";
      }
      return k ?? "any";
    }
    if (isLookup(e)) {
      const got = scope.lookup ? scope.lookup(e.lookup) : `There is no sheet “${e.lookup.sheet}” to look in.`;
      if (!KINDS.includes(got as Kind)) {
        errors.push(got);
        return "any";
      }
      return got as Kind;
    }
    if (isInForce(e)) {
      const got = scope.inForce ? scope.inForce(e.inForce) : `There is no dated sheet “${e.inForce.sheet}”.`;
      if (!KINDS.includes(got as Kind)) {
        errors.push(got);
        return "any";
      }
      return got as Kind;
    }
    if (isSumOf(e)) {
      const err = scope.sumOf(e.sumOf);
      if (err) errors.push(err);
      return "num";
    }
    if (isBalanceOf(e)) {
      const err = scope.balanceOf ? scope.balanceOf(e.balanceOf) : `There is no ledger “${e.balanceOf.sheet}”.`;
      if (err) errors.push(err);
      return "num";
    }
    if (!isOp(e)) return "any";

    const kinds = e.args.map(go);
    const need = (n: number) => {
      if (e.args.length !== n) errors.push(`“${e.op}” takes ${n} ${n === 1 ? "value" : "values"}.`);
    };
    const all = (k: Kind, what: string) => {
      if (kinds.some((x) => !fits(x, k))) errors.push(`“${e.op}” works on ${what} only.`);
    };

    switch (e.op) {
      case "and": case "or":
        if (e.args.length < 2) errors.push(`“${e.op}” takes at least 2 values.`);
        all("bool", "yes/no conditions");
        return "bool";
      case "not":
        need(1); all("bool", "yes/no conditions");
        return "bool";
      case "eq": case "ne":
        need(2);
        if (kinds.length === 2 && !fits(kinds[0]!, kinds[1]!)) errors.push(`“${e.op}” compares two different kinds of value.`);
        return "bool";
      case "gt": case "gte": case "lt": case "lte":
        need(2);
        if (kinds.length === 2 && kinds.includes("range"))
          // A money range is two amounts: say how to name one (M25: "above the top of the salary band").
          errors.push(`“${e.op}” compares two numbers or two dates. A money range is two amounts: compare its top or its bottom, {"col":"<the range column>","part":"to"} or "part":"from".`);
        else if (kinds.length === 2 && (!fits(kinds[0]!, kinds[1]!) || !["num", "date", "datetime", "any", "null"].includes(kinds[0]!)))
          errors.push(`“${e.op}” compares two numbers or two dates.`);
        return "bool";
      case "between":
        need(3);
        if (!kinds.every((k) => fits(k, kinds[0]!)) || !["num", "date", "any"].includes(kinds[0]!))
          errors.push("“between” takes three numbers or three dates.");
        return "bool";
      case "in":
        if (e.args.length < 2) errors.push("“in” takes a value and at least one choice.");
        if (e.args.slice(1).some((a) => typeof a === "object" && a !== null)) errors.push("“in” lists fixed values only.");
        return "bool";
      case "empty":
        need(1);
        return "bool";
      case "add": case "mul": case "div":
        need(2); all("num", "numbers");
        return "num";
      case "sub":
        need(2);
        if (kinds[0] === "date" && kinds[1] === "date") return "num"; // days between
        all("num", "numbers");
        return "num";
      case "days_until":
        need(1); all("date", "dates");
        return "num";
      case "date_add":
        need(3);
        if (!fits(kinds[0]!, "date") || !fits(kinds[1]!, "num")) errors.push("“date_add” takes a date and a number.");
        if (!DATE_UNITS.includes(e.args[2] as never)) errors.push("“date_add” counts in days, months or years.");
        return "date";
      case "workdays":
        need(2); all("date", "dates");
        return "num";
      case "if":
        need(3);
        if (!fits(kinds[0]!, "bool")) errors.push("“if” starts with a yes/no condition.");
        if (kinds.length === 3 && !fits(kinds[1]!, kinds[2]!)) errors.push("“if” gives two different kinds of value.");
        return kinds[1] === "null" || kinds[1] === "any" ? (kinds[2] ?? "any") : kinds[1]!;
    }
  }

  const kind = go(e);
  return { kind, errors };
}
