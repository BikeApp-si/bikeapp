import { describe, expect, it } from "vitest";
import type { CapabilityFile } from "../schema/file";
import { validateFile } from "../schema/validate";
import { notAdditive } from "../plans/compile";
import { spendingLimitsVersion } from "../fixtures";
import { applyChanges } from "./changes";
import { compileCustomize } from "./compile";
import type { CustomizeChange } from "./draft";

// Spending limits added to Spend by Customize (M30), as prompt 3 writes it: a new sheet kept by date for each category,
// its Until added by the kernel, and a check on expenses that reads the limit in force on the expense's date.

const CAP = "10000000-0000-4000-8000-0000000000d0";
const CATEGORIES = [
  { id: "meals", name: "Meals" },
  { id: "travel", name: "Travel" },
  { id: "other", name: "Other" },
];
const spend: CapabilityFile = {
  name: "Spend",
  icon: "wallet",
  sheets: [
    {
      id: "expenses",
      name: "Expenses",
      kind: "list",
      titleColumn: "what",
      row: { one: "expense", many: "expenses" },
      columns: [
        { id: "what", name: "What for", type: "text", required: true },
        { id: "who", name: "Who", type: "person", required: true, default: { kind: "creator" } },
        { id: "date", name: "Date", type: "date", required: true },
        { id: "amount", name: "Amount", type: "money", required: true },
        { id: "category", name: "Category", type: "choice", options: CATEGORIES },
      ],
    },
  ],
  roles: [{ id: "finance", name: "Finance", members: { kind: "everyone" }, can: ["see", "add", "edit", "delete", "customize"], scope: "all" }],
  rules: [],
  later: [],
};
const world = { capId: CAP, files: new Map([[CAP, spend]]), people: new Map<string, string>() };
const none = { sheet: null, new_sheet: null, column: null, step: null, after: null, rename: null, movers: null, role: null, person: null, rule: null, view: null, labels: null, hint: null, sort: null, check: null, form: null, show_when: null, access: null, link: null, formula: null, explain: "x", part: "x" };
const col = (name: string, type: string, more: object = {}) => ({ name, type, required: false, default: null, options: [], link: null, formula: null, result: null, ...more });
const LIMIT = { inForce: { sheet: "Spending limits", is: "Category", on: "Date", value: "Limit" } };

const limitsSheet = (over: object = {}) => ({
  ...none,
  kind: "add_sheet",
  new_sheet: {
    name: "Spending limits",
    kind: "dated",
    parent_sheet: null,
    dated_key: "Category",
    dated_from: "From",
    title_column: "Category",
    row_one: "limit",
    row_many: "limits",
    add_action: "Add a spending limit",
    columns: [col("Category", "choice", { options: ["Meals", "Travel", "Other"] }), col("From", "date"), col("Limit", "money", { required: true })],
    steps: [],
    ...over,
  },
});
const CHANGES = [
  limitsSheet(),
  {
    ...none,
    kind: "add_sheet_check",
    sheet: "Expenses",
    check: { name: "Within the limit", condition: JSON.stringify({ op: "or", args: [{ op: "empty", args: [LIMIT] }, { op: "lte", args: [{ col: "Amount" }, LIMIT] }] }) },
  },
] as unknown as CustomizeChange[];

describe("spending limits from Customize", () => {
  it("compiles a sheet kept by date with the Until the kernel keeps, and a check reading the limit in force", () => {
    const c = compileCustomize(CHANGES, world);
    expect(c.problems).toEqual([]);
    const after = applyChanges(spend, c.changes);
    const limits = after.sheets.find((s) => s.name === "Spending limits")!;
    expect(limits).toMatchObject({ kind: "dated", dated: { key: "category", from: "from", until: "until" } });
    expect(limits.columns.map((x) => [x.name, x.type, !!x.required])).toEqual([
      ["Category", "choice", true],
      ["From", "date", true],
      ["Limit", "money", true],
      ["Until", "date", false],
    ]);
    const limit = { inForce: { sheet: limits.id, is: "category", on: "date", value: "limit" } };
    expect(after.sheets[0]!.checks).toEqual([
      { id: "within_the_limit", name: "Within the limit", condition: { op: "or", args: [{ op: "empty", args: [limit] }, { op: "lte", args: [{ col: "amount" }, limit] }] } },
    ]);
    expect(validateFile(after, { selfId: CAP })).toMatchObject({ ok: true });
    expect(notAdditive(spend, after)).toEqual([]);
  });

  it("refuses a sheet kept by date with no start date, and a value in force read by a key of another kind", () => {
    expect(compileCustomize([limitsSheet({ dated_from: null })] as unknown as CustomizeChange[], world).problems).toEqual([
      "Spending limits: a dated sheet names the date column each row starts on.",
    ]);
    const byWhat = [
      limitsSheet(),
      { ...none, kind: "add_sheet_check", sheet: "Expenses", check: { name: "Within", condition: JSON.stringify({ op: "lte", args: [{ col: "Amount" }, { inForce: { ...LIMIT.inForce, is: "What for" } }] }) } },
    ] as unknown as CustomizeChange[];
    const c = compileCustomize(byWhat, world);
    const r = validateFile(applyChanges(spend, c.changes), { selfId: CAP });
    expect(r.ok ? [] : r.errors.join(" ")).toContain("Spending limits can't be matched to Expenses by “what”");
  });

  it("keeps a sheet kept by date as it is: not turned into a list, not kept by another column", () => {
    const withLimits = spendingLimitsVersion(spend);
    expect(validateFile(withLimits, { selfId: CAP })).toMatchObject({ ok: true });
    const asList = structuredClone(withLimits);
    asList.sheets.find((s) => s.id === "limits")!.kind = "list";
    delete asList.sheets.find((s) => s.id === "limits")!.dated;
    expect(notAdditive(withLimits, asList)).toEqual(["Spending limits can't stop being kept by date: a sheet kept by date starts as a new sheet."]);
    const rekeyed = structuredClone(withLimits);
    rekeyed.sheets.find((s) => s.id === "limits")!.dated!.from = "until";
    expect(notAdditive(withLimits, rekeyed)).toEqual(["Spending limits would be kept by date another way, which moves data."]);
    const becomes = structuredClone(spend);
    becomes.sheets[0]!.kind = "dated";
    expect(notAdditive(spend, becomes)).toEqual(["Expenses can't become kept by date: a sheet kept by date starts as a new sheet."]);
  });
});
