import { describe, expect, it } from "vitest";
import { contractsFile } from "../fixtures";
import type { Expr } from "./ast";
import { readsOtherRows, usesToday } from "./ast";
import { checkExpr, type Kind } from "./check";
import { addToDate, evaluate, workdays } from "./evaluate";
import { renderExpr } from "./render";

const row: Record<string, unknown> = { value: 5_760_000, start: "2025-02-03", renews: "2027-02-02", notice: 90, customer: "Brightline", status: "active", none: null };
const env = { value: (c: string) => row[c], today: "2026-10-26", sumOf: () => 1200 };
const ev = (e: Expr) => evaluate(e, env);
const col = (c: string) => ({ col: c });

describe("evaluate", () => {
  it.each<[string, Expr, unknown]>([
    ["and", { op: "and", args: [true, { op: "gt", args: [col("value"), 0] }] }, true],
    ["and with a false", { op: "and", args: [true, false] }, false],
    ["or", { op: "or", args: [false, true] }, true],
    ["not", { op: "not", args: [false] }, true],
    ["eq", { op: "eq", args: [col("status"), "active"] }, true],
    ["eq empty", { op: "eq", args: [col("none"), null] }, true],
    ["ne", { op: "ne", args: [col("status"), "draft"] }, true],
    ["gt money in cents", { op: "gt", args: [col("value"), 5_000_000] }, true],
    ["gte", { op: "gte", args: [col("notice"), 90] }, true],
    ["lt", { op: "lt", args: [col("notice"), 90] }, false],
    ["lte dates", { op: "lte", args: [col("start"), col("renews")] }, true],
    ["gt with an empty value never matches", { op: "gt", args: [col("none"), 0] }, false],
    ["between", { op: "between", args: [col("notice"), 30, 90] }, true],
    ["in", { op: "in", args: [col("status"), "signed", "active"] }, true],
    ["empty", { op: "empty", args: [col("none")] }, true],
    ["add", { op: "add", args: [col("notice"), 10] }, 100],
    ["add with empty is empty", { op: "add", args: [col("none"), 10] }, null],
    ["sub numbers", { op: "sub", args: [col("value"), 760_000] }, 5_000_000],
    ["sub dates gives days", { op: "sub", args: [col("renews"), col("start")] }, 729],
    ["mul", { op: "mul", args: [3, 1250] }, 3750],
    ["div", { op: "div", args: [10, 4] }, 2.5],
    ["div by zero is empty", { op: "div", args: [10, 0] }, null],
    ["days_until", { op: "days_until", args: [col("renews")] }, 99],
    ["today", { ref: "today" }, "2026-10-26"],
    ["date_add years", { op: "date_add", args: [col("start"), 1, "years"] }, "2026-02-03"],
    ["date_add months clamps", { op: "date_add", args: ["2026-01-31", 1, "months"] }, "2026-02-28"],
    ["date_add days back", { op: "date_add", args: [col("start"), -3, "days"] }, "2025-01-31"],
    ["workdays Mon–Wed", { op: "workdays", args: ["2026-11-23", "2026-11-25"] }, 3],
    ["sumOf", { sumOf: { sheet: "lines", column: "amount" } }, 1200],
    ["if, true", { op: "if", args: [{ op: "eq", args: [col("customer"), "Brightline"] }, 90, 30] }, 90],
    ["if, false", { op: "if", args: [{ op: "eq", args: [col("customer"), "Kova"] }, 90, 30] }, 30],
  ])("%s", (_, e, want) => expect(ev(e)).toEqual(want));

  it("reads a linked row's column, a range's ends and a looked-up value", () => {
    const linked: Record<string, unknown> = { band: { from: 14_000_000, to: 16_000_000 }, manager: "priya" };
    const more = { ...env, linked: (via: string, c: string) => (via === "opening" ? linked[c] : undefined), lookup: () => 12 };
    expect(evaluate({ col: "manager", via: "opening" }, more)).toBe("priya");
    expect(evaluate({ col: "band", via: "opening", part: "to" }, more)).toBe(16_000_000);
    expect(evaluate({ op: "gt", args: [16_800_000, { col: "band", via: "opening", part: "to" }] }, more)).toBe(true);
    expect(evaluate({ lookup: { sheet: "balances", where: "who", is: "who", value: "left" } }, more)).toBe(12);
    // Nothing to read: empty, so a comparison never matches.
    expect(evaluate({ op: "gt", args: [1, { col: "band", via: "opening", part: "to" }] }, env)).toBe(false);
  });

  it("reads the value in force from the environment (M30), and is empty without it", () => {
    const f: Expr = { inForce: { sheet: "limits", is: "category", on: "date", value: "limit" } };
    expect(evaluate(f, { ...env, inForce: () => 7500 })).toBe(7500);
    expect(evaluate(f, env)).toBe(null);
    expect(evaluate({ op: "lte", args: [8500, f] }, { ...env, inForce: () => 7500 })).toBe(false);
    // Read from other rows, so worked out when read, never stored.
    expect(readsOtherRows(f)).toBe(true);
  });

  it("gives the same result every time (determinism)", () => {
    const e: Expr = { op: "and", args: [{ op: "gt", args: [{ op: "days_until", args: [col("renews")] }, 30] }, { op: "in", args: [col("status"), "active"] }] };
    const first = ev(e);
    for (let i = 0; i < 100; i++) expect(ev(e)).toBe(first);
  });

  it("counts workdays across a weekend and leap years", () => {
    expect(workdays("2026-12-28", "2026-12-31")).toBe(4); // X1: Maya, Dec 28–31
    expect(workdays("2026-11-27", "2026-11-30")).toBe(2); // Fri to Mon
    expect(addToDate("2024-02-29", 1, "years")).toBe("2025-02-28");
  });

  it("knows which expressions depend on today", () => {
    expect(usesToday({ op: "days_until", args: [col("renews")] })).toBe(true);
    expect(usesToday({ op: "date_add", args: [col("start"), 1, "years"] })).toBe(false);
    expect(usesToday({ ref: "row" })).toBe(false);
  });

  it("names the row itself, for a rule's field map", () => {
    expect(evaluate({ ref: "row" }, { value: () => null, today: "2026-10-27", rowId: "r-1" })).toBe("r-1");
    expect(evaluate({ ref: "row" }, { value: () => null, today: "2026-10-27" })).toBe(null);
  });
});

describe("checkExpr", () => {
  const kinds: Record<string, Kind> = { value: "num", start: "date", customer: "text", flag: "bool" };
  const scope = { column: (c: string) => kinds[c] ?? null, sumOf: () => null };
  const check = (e: Expr) => checkExpr(e, scope);

  it("gives the kind of a good expression", () => {
    expect(check({ op: "gt", args: [col("value"), 100] })).toEqual({ kind: "bool", errors: [] });
    expect(check({ op: "date_add", args: [col("start"), 1, "years"] })).toEqual({ kind: "date", errors: [] });
    expect(check({ op: "sub", args: [col("start"), col("start")] }).kind).toBe("num");
    expect(check({ op: "if", args: [col("flag"), 90, 30] })).toEqual({ kind: "num", errors: [] });
  });

  it("refuses an if without a condition, or with two kinds of value", () => {
    expect(check({ op: "if", args: [col("value"), 90, 30] }).errors).toEqual(["“if” starts with a yes/no condition."]);
    expect(check({ op: "if", args: [col("flag"), 90, col("start")] }).errors).toEqual(["“if” gives two different kinds of value."]);
  });

  it.each<[string, Expr, RegExp]>([
    ["an unknown column", col("ghost"), /no column “ghost”/],
    ["adding text", { op: "add", args: [col("customer"), 1] }, /numbers only/],
    ["comparing text with a number", { op: "gt", args: [col("customer"), 1] }, /two different kinds|two numbers or two dates/],
    ["and of non-conditions", { op: "and", args: [col("value"), true] }, /yes\/no/],
    ["the wrong number of values", { op: "not", args: [true, false] }, /takes 1 value/],
    ["an unknown unit", { op: "date_add", args: [col("start"), 1, "weeks"] }, /days, months or years/],
    ["days until a number", { op: "days_until", args: [col("value")] }, /dates only/],
    ["in with a column as a choice", { op: "in", args: [col("customer"), col("customer")] }, /fixed values/],
    ["a part of a number", { col: "value", part: "to" }, /Only a money range/],
    ["a linked value with no link", { col: "x", via: "ghost" }, /no link column “ghost”/],
    ["a lookup with nowhere to look", { lookup: { sheet: "b", where: "w", is: "i", value: "v" } }, /no sheet “b”/],
    ["a value in force with no dated sheet", { inForce: { sheet: "b", value: "v" } }, /no dated sheet “b”/],
  ])("refuses %s", (_, e, msg) => expect(check(e).errors.join()).toMatch(msg));

  it("takes the kind of a linked value and a lookup from the scope", () => {
    const more = { ...scope, column: (c: string) => (c === "band" ? ("range" as Kind) : scope.column(c)), linked: () => "range" as Kind, lookup: () => "num" as Kind };
    expect(checkExpr({ col: "band", via: "opening", part: "to" }, more)).toEqual({ kind: "num", errors: [] });
    expect(checkExpr({ op: "lte", args: [col("value"), { lookup: { sheet: "b", where: "w", is: "i", value: "v" } }] }, more)).toEqual({ kind: "bool", errors: [] });
    expect(checkExpr({ col: "x", via: "opening" }, { ...more, linked: () => "The row has no column “x”." }).errors).toEqual(["The row has no column “x”."]);
  });

  it("says how to compare a money range: by its top or its bottom", () => {
    const more = { ...scope, column: (c: string) => (c === "band" ? ("range" as Kind) : scope.column(c)) };
    expect(checkExpr({ op: "gt", args: [col("value"), col("band")] }, more).errors.join()).toMatch(/compare its top or its bottom, \{"col":"<the range column>","part":"to"\}/);
    expect(checkExpr({ op: "gt", args: [col("value"), { col: "band", part: "to" }] }, more)).toEqual({ kind: "bool", errors: [] });
  });
});

describe("renderExpr", () => {
  const sheet = contractsFile().sheets[0]!;
  const ctx = { column: (id: string) => sheet.columns.find((c) => c.id === id), otherColumn: () => ({ sheet: "Lines", column: "Amount" }) };
  const r = (e: Expr) => renderExpr(e, ctx);

  it("reads in plain words, money and days in their own terms", () => {
    expect(r({ op: "gt", args: [col("value"), 5_000_000] })).toBe("Value a year over $50,000");
    expect(r({ op: "date_add", args: [col("start"), 1, "years"] })).toBe("Start + 1 year");
    expect(r({ op: "lte", args: [col("notice"), 30] })).toBe("Notice at most 30 days");
    expect(r({ op: "in", args: [col("customer"), "Kova", "Brightline", "Northwind"] })).toBe("Customer is Kova, Brightline or Northwind");
    expect(r({ op: "eq", args: [col("start"), "2026-11-02"] })).toBe("Start is Nov 2, 2026");
    expect(r({ sumOf: { sheet: "lines", column: "amount" } })).toBe("the total of Amount in Lines");
  });

  it("reads an if, and a pick between a choice's two options", () => {
    const tier = { id: "tier", name: "Customer tier", type: "choice" as const, options: [{ id: "standard", name: "Standard" }, { id: "enterprise", name: "Enterprise" }] };
    const withTier = { ...ctx, column: (id: string) => (id === "tier" ? tier : ctx.column(id)) };
    expect(renderExpr({ op: "if", args: [{ op: "eq", args: [col("tier"), "enterprise"] }, 90, 30] }, withTier)).toBe("90 for Enterprise, 30 for Standard");
    expect(renderExpr({ op: "if", args: [{ op: "gt", args: [col("value"), 5_000_000] }, 90, 30] }, ctx)).toBe("90 if Value a year over $50,000, otherwise 30");
  });

  it("reads a sum limited to steps", () => {
    const steps = { ...ctx, otherStep: (_s: string, id: string) => ({ paid: "Paid", approved: "Approved" })[id] };
    expect(renderExpr({ sumOf: { sheet: "bills", column: "amount", by: "budget", steps: ["paid"] } }, steps)).toBe("the total of Amount in Lines at Paid");
    expect(renderExpr({ sumOf: { sheet: "bills", column: "amount", by: "budget", steps: ["approved", "paid"] } }, steps)).toBe("the total of Amount in Lines at Approved or Paid");
  });

  it("reads a linked value and a lookup", () => {
    const more = {
      ...ctx,
      column: (id: string) => (id === "opening" ? { id, name: "Opening", type: "link" as const } : id === "offer" ? { id, name: "Offer", type: "money" as const } : ctx.column(id)),
      linkedColumn: () => ({ id: "band", name: "Salary band", type: "money_range" as const }),
      otherColumn: () => ({ sheet: "Balances", column: "Left" }),
    };
    expect(renderExpr({ op: "gt", args: [{ col: "offer" }, { col: "band", via: "opening", part: "to" }] }, more)).toBe("Offer over the top of Salary band of the Opening");
    expect(renderExpr({ lookup: { sheet: "balances", where: "who", is: "owner", value: "left" } }, more)).toBe("Left in Balances for the same Owner");
  });

  it("reads a value in force on a date, or today (M30)", () => {
    const more = {
      ...ctx,
      column: (id: string) => ({ category: { id, name: "Category", type: "choice" as const }, date: { id, name: "Date", type: "date" as const } })[id] ?? ctx.column(id),
      otherColumn: () => ({ sheet: "Spending limits", column: "Limit" }),
    };
    expect(renderExpr({ inForce: { sheet: "limits", is: "category", on: "date", value: "limit" } }, more)).toBe("the Limit in Spending limits for the same Category, in force on Date");
    expect(renderExpr({ inForce: { sheet: "rates", value: "rate" } }, more)).toBe("the Limit in Spending limits, in force today");
  });

  it("reads the same every time", () => {
    const e: Expr = { op: "and", args: [{ op: "gt", args: [col("value"), 5_000_000] }, { op: "empty", args: [col("start")] }] };
    expect(r(e)).toBe(r(structuredClone(e)));
    expect(r(e)).toBe("Value a year over $50,000 and Start is empty");
  });
});

describe("renderDefaultHint", () => {
  it("words a worked-out default for the form", async () => {
    const { renderDefaultHint } = await import("./render");
    const ctx = { column: (id: string) => ({ id, name: id === "start" ? "Start" : "Renews on", type: "date" as const }), otherColumn: () => ({ sheet: "", column: "" }) };
    expect(renderDefaultHint({ op: "date_add", args: [{ col: "start" }, 1, "years"] }, ctx)).toBe("Leave empty for one year after Start.");
    expect(renderDefaultHint({ op: "date_add", args: [{ col: "renews" }, -30, "days"] }, ctx)).toBe("Leave empty for 30 days before Renews on.");
  });
});
