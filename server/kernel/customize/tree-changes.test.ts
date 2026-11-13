import { describe, expect, it } from "vitest";
import type { CapabilityFile } from "../schema/file";
import { validateFile } from "../schema/validate";
import { applyChanges } from "./changes";
import { compileCustomize } from "./compile";
import type { CustomizeChange } from "./draft";

// Cost centres added to Spend by Customize (M28), as prompt 3 writes them: a tree sheet whose Spent adds up the
// expenses that name one, through a link added to Expenses by a later change in the same set, and whose Total spent
// adds up its own sheet. The new sheet's totals are worked out after the other changes, so both can be named.

const CAP = "10000000-0000-4000-8000-0000000000ab";
const spend: CapabilityFile = {
  name: "Spend",
  icon: "wallet",
  sheets: [
    {
      id: "expenses",
      name: "Expenses",
      kind: "list",
      titleColumn: "what",
      columns: [
        { id: "what", name: "What for", type: "text", required: true },
        { id: "amount", name: "Amount", type: "money", required: true },
        { id: "status", name: "Status", type: "step" },
      ],
      steps: [{ id: "submitted", name: "Submitted", start: true }, { id: "paid", name: "Paid", end: "final" }],
    },
  ],
  roles: [],
  rules: [],
  later: [],
};
const world = { capId: CAP, files: new Map([[CAP, spend]]), people: new Map<string, string>() };
const none = { sheet: null, new_sheet: null, column: null, step: null, after: null, rename: null, movers: null, role: null, person: null, rule: null, view: null, labels: null, hint: null, sort: null, check: null, form: null, show_when: null, access: null, link: null, explain: "x", part: "x" };
const col = (name: string, type: string, more: object = {}) => ({ name, type, required: false, default: null, options: [], link: null, formula: null, result: null, ...more });

const CHANGES = [
  {
    ...none,
    kind: "add_sheet",
    new_sheet: {
      name: "Cost centres",
      kind: "tree",
      parent_sheet: null,
      tree_parent: "Under",
      title_column: "Name",
      row_one: "cost centre",
      row_many: "cost centres",
      add_action: "Add a cost centre",
      columns: [
        col("Name", "text", { required: true }),
        col("Under", "link", { link: { capability: null, sheet: "Cost centres" } }),
        col("Spent", "computed", { result: "money", formula: JSON.stringify({ sumOf: { sheet: "Expenses", column: "Amount", by: "Cost centre", steps: ["Paid"] } }) }),
        col("Total spent", "computed", { result: "money", formula: JSON.stringify({ op: "add", args: [{ col: "Spent" }, { sumOf: { sheet: "Cost centres", column: "Total spent", by: "Under" } }] }) }),
      ],
      steps: [],
    },
  },
  { ...none, kind: "add_column", sheet: "Expenses", column: col("Cost centre", "link", { link: { capability: null, sheet: "Cost centres" } }) },
] as unknown as CustomizeChange[];

describe("cost centres from Customize", () => {
  it("compiles a tree whose totals name a link added after it, and its own total", () => {
    const c = compileCustomize(CHANGES, world);
    expect(c.problems).toEqual([]);
    const after = applyChanges(spend, c.changes);
    const centres = after.sheets.find((s) => s.name === "Cost centres")!;
    expect(centres).toMatchObject({ kind: "tree", tree: { parent: "under" } });
    expect(centres.columns.map((x) => x.id)).toEqual(["name", "under", "spent", "total_spent"]);
    expect(centres.columns.find((x) => x.id === "spent")!.expr).toEqual({ sumOf: { sheet: "expenses", column: "amount", by: "cost_centre", steps: ["paid"] } });
    expect(centres.columns.find((x) => x.id === "total_spent")!.expr).toEqual({ op: "add", args: [{ col: "spent" }, { sumOf: { sheet: "cost_centres", column: "total_spent", by: "under" } }] });
    expect(validateFile(after, { selfId: CAP })).toMatchObject({ ok: true });
  });

  it("compiles the same totals added as their own changes after the sheet", () => {
    const sheet = CHANGES[0]!.new_sheet!;
    const [spent, total] = sheet.columns.filter((x) => x.type === "computed");
    const split = [
      { ...CHANGES[0]!, new_sheet: { ...sheet, columns: sheet.columns.filter((x) => x.type !== "computed") } },
      CHANGES[1]!,
      { ...none, kind: "add_column", sheet: "Cost centres", column: spent },
      { ...none, kind: "add_column", sheet: "Cost centres", column: total },
    ] as unknown as CustomizeChange[];
    const c = compileCustomize(split, world);
    expect(c.problems).toEqual([]);
    const centres = applyChanges(spend, c.changes).sheets.find((s) => s.name === "Cost centres")!;
    expect(centres.columns.find((x) => x.id === "total_spent")!.expr).toEqual({ op: "add", args: [{ col: "spent" }, { sumOf: { sheet: "cost_centres", column: "total_spent", by: "under" } }] });
  });

  it("refuses a total that reads itself in a circle", () => {
    const loop = [...CHANGES, { ...none, kind: "add_column", sheet: "Cost centres", column: col("Twice", "computed", { result: "money", formula: JSON.stringify({ op: "add", args: [{ col: "Twice" }, 1] }) }) }] as unknown as CustomizeChange[];
    const c = compileCustomize(loop, world);
    const after = applyChanges(spend, c.changes);
    expect(validateFile(after, { selfId: CAP })).toMatchObject({ ok: false });
  });
});
