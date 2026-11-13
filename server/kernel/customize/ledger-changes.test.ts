import { describe, expect, it } from "vitest";
import type { CapabilityFile } from "../schema/file";
import { validateFile } from "../schema/validate";
import { notAdditive } from "../plans/compile";
import { leaveLedgerVersion } from "../fixtures";
import { applyChanges } from "./changes";
import { accessLines, setSheetAccess } from "./sheet-access";
import { compileCustomize } from "./compile";
import type { CustomizeChange } from "./draft";

// A leave ledger added to Time off by Customize (M29), as prompt 3 writes it: a new ledger sheet kept by person, its
// Balance after and Reverses added by the kernel, and Left worked out again to count the entries (set_formula). The
// rule that adds an entry on approval goes to the logic writer as a sentence.

const CAP = "10000000-0000-4000-8000-0000000000cd";
const timeOff: CapabilityFile = {
  name: "Time off",
  icon: "calendar-days",
  sheets: [
    {
      id: "requests",
      name: "Requests",
      kind: "list",
      titleColumn: "who",
      columns: [
        { id: "who", name: "Who", type: "person", required: true },
        { id: "days", name: "Days", type: "number", required: true },
        { id: "status", name: "Status", type: "step" },
      ],
      steps: [{ id: "submitted", name: "Submitted", start: true }, { id: "approved", name: "Approved", end: "final" }],
    },
    {
      id: "balances",
      name: "Balances",
      kind: "list",
      titleColumn: "who",
      columns: [
        { id: "who", name: "Who", type: "person", required: true },
        { id: "allowance", name: "Days a year", type: "days" },
        { id: "used", name: "Used", type: "days" },
        { id: "left", name: "Left", type: "computed", result: "days", expr: { op: "sub", args: [{ col: "allowance" }, { col: "used" }] } },
      ],
    },
  ],
  roles: [],
  rules: [],
  later: [],
};
const world = { capId: CAP, files: new Map([[CAP, timeOff]]), people: new Map<string, string>() };
const none = { sheet: null, new_sheet: null, column: null, step: null, after: null, rename: null, movers: null, role: null, person: null, rule: null, view: null, labels: null, hint: null, sort: null, check: null, form: null, show_when: null, access: null, link: null, formula: null, explain: "x", part: "x" };
const col = (name: string, type: string, more: object = {}) => ({ name, type, required: false, default: null, options: [], link: null, formula: null, result: null, ...more });

const CHANGES = [
  {
    ...none,
    kind: "add_sheet",
    new_sheet: {
      name: "Leave entries",
      kind: "ledger",
      parent_sheet: null,
      ledger_account: "Who",
      ledger_amount: "Days",
      ledger_min: null,
      title_column: "Entry",
      row_one: "entry",
      row_many: "entries",
      add_action: "New entry",
      columns: [col("Entry", "text", { required: true }), col("Who", "person"), col("Days", "days"), col("Request", "link", { link: { capability: null, sheet: "Requests" } })],
      steps: [],
    },
  },
  { ...none, kind: "rule", rule: { sentence: "When a request is approved, add a leave entry taking its days off.", replaces: null } },
  {
    ...none,
    kind: "set_formula",
    sheet: "Balances",
    formula: { column: "Left", formula: JSON.stringify({ op: "add", args: [{ op: "sub", args: [{ col: "Days a year" }, { col: "Used" }] }, { balanceOf: { sheet: "Leave entries", of: "Who" } }] }) },
  },
] as unknown as CustomizeChange[];

describe("a leave ledger from Customize", () => {
  it("compiles a ledger with the columns the kernel keeps, and Left counting its entries", () => {
    const c = compileCustomize(CHANGES, world);
    expect(c.problems).toEqual([]);
    expect(c.rules).toEqual([{ sentence: "When a request is approved, add a leave entry taking its days off.", replaces: null }]);
    const after = applyChanges(timeOff, c.changes);
    const leave = after.sheets.find((s) => s.name === "Leave entries")!;
    expect(leave).toMatchObject({ kind: "ledger", ledger: { account: "who", amount: "days", balance: "balance_after", reverses: "reverses" } });
    expect(leave.columns.map((x) => [x.name, x.type, !!x.required])).toEqual([
      ["Entry", "text", true],
      ["Who", "person", true],
      ["Days", "days", true],
      ["Request", "link", false],
      ["Balance after", "days", false],
      ["Reverses", "link", false],
    ]);
    expect(after.sheets.find((s) => s.id === "balances")!.columns.find((x) => x.id === "left")!.expr).toEqual({
      op: "add",
      args: [{ op: "sub", args: [{ col: "allowance" }, { col: "used" }] }, { balanceOf: { sheet: leave.id, of: "who" } }],
    });
    expect(validateFile(after, { selfId: CAP })).toMatchObject({ ok: true });
    expect(notAdditive(timeOff, after)).toEqual([]);
  });

  it("refuses a formula on an answered question", () => {
    const c = compileCustomize([{ ...none, kind: "set_formula", sheet: "Balances", formula: { column: "Used", formula: "1" } } as unknown as CustomizeChange], world);
    expect(c.problems).toEqual(["Time off › Balances: Used is answered, not worked out, so it has no formula to change."]);
  });

  it("keeps a ledger a ledger, kept the same way", () => {
    const withLedger = leaveLedgerVersion(timeOff);
    const asList = structuredClone(withLedger);
    asList.sheets.find((s) => s.id === "leave")!.kind = "list";
    delete asList.sheets.find((s) => s.id === "leave")!.ledger;
    expect(notAdditive(withLedger, asList)).toEqual(["Leave entries can't stop being a ledger: a ledger's entries are only added, so it starts as a new sheet."]);
    const floored = structuredClone(withLedger);
    floored.sheets.find((s) => s.id === "leave")!.ledger!.min = 0;
    expect(notAdditive(withLedger, floored)).toEqual(["Leave entries would keep its balance another way, which moves data."]);
    const becomes = structuredClone(timeOff);
    becomes.sheets[1]!.kind = "ledger";
    expect(notAdditive(timeOff, becomes)).toEqual(["Balances can't become a ledger: a ledger's entries are only added, so it starts as a new sheet."]);
  });
});

// Who sees a ledger added by Customize: a role that sees its own rows only sees the entries that name them, and never
// adds, changes or reverses one (or employees could give themselves days); a role that sees its team's rows doesn't
// see it until an admin says so.
describe("who sees a leave ledger", () => {
  const PERSON = "00000000-0000-4000-8000-0000000000aa";
  const withRoles: CapabilityFile = {
    ...timeOff,
    roles: [
      { id: "admins", name: "Time off admins", members: { kind: "people", people: [PERSON] }, can: ["see", "add", "edit", "delete", "move_steps", "customize"], scope: "all" },
      { id: "everyone", name: "Everyone", members: { kind: "everyone" }, can: ["see", "add", "edit"], scope: "own", scopeColumns: { requests: { column: "who" }, balances: { column: "who" } } },
      { id: "managers", name: "Managers", members: { kind: "everyone" }, can: ["see", "move_steps"], scope: "team", scopeColumns: { requests: { column: "who" }, balances: { column: "who" } } },
    ],
  };
  const applied = () => {
    const w = { ...world, files: new Map([[CAP, withRoles]]) };
    const c = compileCustomize(CHANGES.filter((x) => x.kind === "add_sheet"), w);
    return applyChanges(withRoles, c.changes);
  };

  it("gives Everyone only their own entries, seen and nothing more, and Managers none", () => {
    const after = applied();
    const leave = after.sheets.find((s) => s.name === "Leave entries")!;
    const everyone = after.roles.find((r) => r.id === "everyone")!;
    expect(everyone.sheets).toEqual(["requests", "balances"]);
    expect(after.roles.find((r) => r.beside?.role === "everyone")).toMatchObject({ can: ["see"], scope: "own", sheets: [leave.id], scopeColumns: { [leave.id]: { column: "who" } } });
    expect(after.roles.find((r) => r.id === "managers")!.sheets).toEqual(["requests", "balances"]);
    expect(after.roles.some((r) => r.beside?.role === "managers")).toBe(false);
    expect(accessLines(withRoles, after)).toEqual(["Everyone see their own entries, by Who.", "Managers won't see Leave entries yet."]);
    expect(validateFile(after, { selfId: CAP })).toMatchObject({ ok: true });
  });

  it("never lets a later access change give a role that sees its own rows more than seeing entries", () => {
    const after = applied();
    const leave = after.sheets.find((s) => s.name === "Leave entries")!;
    setSheetAccess(after, { role: "managers", sheet: leave.id, sees: "by_column", column: "who" });
    expect(after.roles.find((r) => r.beside?.role === "managers")).toMatchObject({ can: ["see"], scope: "own" });
    setSheetAccess(after, { role: "everyone", sheet: leave.id, sees: "all" });
    expect(after.roles.find((r) => r.beside?.role === "everyone")).toMatchObject({ can: ["see"], scope: "all" });
    expect(after.roles.find((r) => r.id === "everyone")!.sheets).not.toContain(leave.id);
  });
});
