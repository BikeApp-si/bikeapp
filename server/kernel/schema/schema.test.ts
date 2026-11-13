import { describe, expect, it } from "vitest";
import { contractsFile, ordersFile, receiptsFile, PEOPLE } from "../fixtures";
import type { CapabilityFile } from "./file";
import { validateFile } from "./validate";

const RECEIPTS = "10000000-0000-4000-8000-000000000001";
const others = new Map([[RECEIPTS, receiptsFile()]]);
const people = new Set(Object.values(PEOPLE));

function errorsOf(file: unknown, ctx = { others, people }) {
  const r = validateFile(file, ctx);
  return r.ok ? [] : r.errors;
}
const edit = (f: (file: CapabilityFile) => void, base = contractsFile()) => {
  const copy = structuredClone(base);
  f(copy);
  return copy;
};
const contracts = (f: CapabilityFile) => f.sheets[0]!;

describe("validateFile", () => {
  it("accepts a list with steps and roles, and a document with lines and an allocation", () => {
    expect(errorsOf(contractsFile())).toEqual([]);
    expect(errorsOf(ordersFile(RECEIPTS))).toEqual([]);
    expect(errorsOf(receiptsFile())).toEqual([]);
  });

  it("refuses what the Zod shape doesn't allow", () => {
    expect(errorsOf({ name: "X" })[0]).toMatch(/sheets/);
    expect(errorsOf(edit((f) => (contracts(f).columns[0]!.type = "colour" as never)))[0]).toMatch(/type/);
    expect(errorsOf(edit((f) => (contracts(f).columns[0]!.id = "Has Spaces")))[0]).toMatch(/Ids are lowercase/);
  });

  describe("limits", () => {
    it("6 sheets", () => {
      const add = (n: number) => edit((f) => f.sheets.push(...Array.from({ length: n }, (_, i) => ({ ...structuredClone(contracts(f)), id: `s${i}`, name: `S${i}` }))));
      const have = edit(() => {}).sheets.length;
      expect(errorsOf(add(6 - have)).join()).not.toMatch(/at most \d+ sheets/);
      expect(errorsOf(add(7 - have)).join()).toMatch(/at most 6 sheets/);
    });
    it("40 columns per sheet", () => {
      const upTo = (n: number) => edit((f) => {
        for (let i = contracts(f).columns.length; i < n; i++) contracts(f).columns.push({ id: `x${i}`, name: `X${i}`, type: "text" });
      });
      expect(errorsOf(upTo(40))).toEqual([]);
      expect(errorsOf(upTo(41)).join()).toMatch(/at most 40 columns/);
    });
    it("6 steps per flow, not counting where rows end", () => {
      const more = (n: number) => (f: CapabilityFile) => contracts(f).steps!.splice(4, 0, ...Array.from({ length: n }, (_, i) => ({ id: `extra${i}`, name: `Extra ${i}` })));
      // 4 steps on the way + 2 more = 6, with two end steps: 8 in all, accepted.
      expect(errorsOf(edit(more(2)))).toEqual([]);
      expect(errorsOf(edit(more(3))).join()).toMatch(/at most 6 steps before the end/);
    });
    it("20 rules", () => {
      const rule = { id: "r", text: "t", reading: { when: "w", then: "t" }, trigger: { kind: "row_created" as const, sheet: "contracts" }, actions: [{ kind: "move_to_step" as const, step: "signed" }], enabled: true };
      const rules = (n: number) => edit((f) => (f.rules = Array.from({ length: n }, (_, i) => ({ ...rule, id: `r${i}` }))));
      expect(errorsOf(rules(20)).join()).not.toMatch(/at most \d+ rules/);
      expect(errorsOf(rules(21)).join()).toMatch(/at most 20 rules/);
    });
  });

  it("takes the names a screen shows, a default sort and hint columns", () => {
    const named = edit((f) => {
      contracts(f).row = { one: "contract", many: "contracts" };
      contracts(f).addAction = "New contract";
      contracts(f).sort = { column: "renews", dir: "asc" };
      contracts(f).steps!.find((s) => s.id === "renewed")!.button = "Mark renewed";
      contracts(f).columns.find((c) => c.id === "days_left")!.hintFor = "renews";
    });
    expect(errorsOf(named)).toEqual([]);
    expect(errorsOf(edit((f) => (contracts(f).sort = { column: "nope", dir: "asc" }))).join()).toMatch(/sorted by a column/);
    expect(errorsOf(edit((f) => (contracts(f).columns.find((c) => c.id === "customer")!.hintFor = "value"))).join()).toMatch(/only a computed column/);
    expect(errorsOf(edit((f) => (contracts(f).columns.find((c) => c.id === "days_left")!.hintFor = "nope"))).join()).toMatch(/doesn't exist/);
    expect(errorsOf(edit((f) => (contracts(f).row = { one: "", many: "x" })))[0]).toMatch(/row/);
  });

  it("checks ids, title column, choices and number limits", () => {
    expect(errorsOf(edit((f) => (contracts(f).columns[1]!.id = "customer"))).join()).toMatch(/two columns have the id/);
    expect(errorsOf(edit((f) => (contracts(f).titleColumn = "nope"))).join()).toMatch(/title column/);
    expect(errorsOf(edit((f) => contracts(f).columns.push({ id: "kind", name: "Kind", type: "choice" }))).join()).toMatch(/needs its options/);
    expect(errorsOf(edit((f) => contracts(f).columns.push({ id: "score", name: "Score", type: "number", min: 4, max: 1 }))).join()).toMatch(/lowest value is above/);
    expect(errorsOf(edit((f) => contracts(f).columns.push({ id: "t", name: "T", type: "text", min: 1 }))).join()).toMatch(/only a number/);
  });

  it("checks links, computed columns and defaults", () => {
    expect(errorsOf(edit((f) => contracts(f).columns.push({ id: "l", name: "L", type: "link", link: { sheet: "nowhere" } }))).join()).toMatch(/doesn't exist/);
    expect(errorsOf(edit((f) => contracts(f).columns.push({ id: "c", name: "C", type: "computed", result: "number", expr: { op: "add", args: [{ col: "missing" }, 1] } }))).join()).toMatch(/no column “missing”/);
    expect(errorsOf(edit((f) => contracts(f).columns.push({ id: "c", name: "C", type: "computed", result: "number", expr: { op: "add", args: [{ col: "customer" }, 1] } }))).join()).toMatch(/numbers only/);
    const circle = edit((f) =>
      contracts(f).columns.push(
        { id: "a", name: "A", type: "computed", result: "number", expr: { op: "add", args: [{ col: "b" }, 1] } },
        { id: "b", name: "B", type: "computed", result: "number", expr: { op: "add", args: [{ col: "a" }, 1] } },
      ),
    );
    expect(errorsOf(circle).join()).toMatch(/in a circle/);
    expect(errorsOf(edit((f) => (contracts(f).columns[0]!.default = { kind: "creator" }))).join()).toMatch(/only a person column/);
    expect(errorsOf(edit((f) => (contracts(f).columns[0]!.default = { kind: "today" }))).join()).toMatch(/only a date/);
  });

  it("checks steps: one start first, an end, step conditions", () => {
    expect(errorsOf(edit((f) => delete contracts(f).steps![0]!.start)).join()).toMatch(/exactly one step is where rows start/);
    expect(errorsOf(edit((f) => contracts(f).steps!.forEach((s) => delete s.end))).join()).toMatch(/at least one step is where rows end/);
    expect(errorsOf(edit((f) => (contracts(f).steps![2]!.onlyWhen = { col: "value" }))).join()).toMatch(/yes\/no condition/);
    expect(errorsOf(edit((f) => (contracts(f).columns = contracts(f).columns.filter((c) => c.type !== "step")))).join()).toMatch(/steps but no step column/);
    expect(errorsOf(edit((f) => (contracts(f).steps![1]!.moveIn = "not_submitter"))).join()).toBe("");
    expect(errorsOf(edit((f) => (contracts(f).steps![1]!.moveIn = "manager" as never))).join()).toMatch(/moveIn/);
    expect(errorsOf(edit((f) => (contracts(f).steps![0]!.moveIn = "submitter"))).join()).toMatch(/nobody moves them into it/);
    expect(errorsOf(edit((f) => (contracts(f).steps![5]!.moveOut = "submitter"))).join()).toMatch(/nobody moves them out of it/);
  });

  it("checks lines and allocations", () => {
    const orders = ordersFile(RECEIPTS);
    expect(errorsOf(edit((f) => delete f.sheets[1]!.parentSheet, orders)).join()).toMatch(/lines need a document/);
    expect(errorsOf(edit((f) => delete f.sheets[2]!.allocation, orders)).join()).toMatch(/names what it allocates/);
    expect(errorsOf(edit((f) => (f.sheets[2]!.allocation!.fromLimit = "payer"), orders)).join()).toMatch(/isn't an amount/);
    expect(errorsOf(edit((f) => (f.sheets[0]!.columns[1]!.expr = { sumOf: { sheet: "payments", column: "amount" } }), orders)).join()).toMatch(/aren't lines/);
  });

  describe("roles and scope", () => {
    it("names only people in People", () => {
      expect(errorsOf(contractsFile(["00000000-0000-4000-8000-0000000000ff"])).join()).toMatch(/isn't in People/);
    });
    it("needs a person column for own and team", () => {
      expect(errorsOf(edit((f) => delete f.roles[1]!.scopeColumns)).join()).toMatch(/needs a person column/);
      expect(errorsOf(edit((f) => (f.roles[1]!.scopeColumns = { contracts: { column: "customer" } }))).join()).toMatch(/isn't a person column/);
    });
    it("reaches a person column one link away, never two", () => {
      const hiring = hiringFile();
      expect(errorsOf(hiring)).toEqual([]);
      // Interviews → Candidate → Opening → Hiring manager is two hops: refused when the file is saved.
      const twoHops = edit((f) => (f.roles[0]!.scopeColumns!.interviews = { via: "candidate", column: "manager" }), hiring);
      expect(errorsOf(twoHops).join()).toMatch(/at most one link away/);
    });
  });

  it("checks rules against the sheet", () => {
    const rule = { id: "r1", text: "Move it", reading: { when: "w", then: "t" }, trigger: { kind: "enters_step" as const, sheet: "contracts", step: "nope" }, actions: [{ kind: "move_to_step" as const, step: "gone" }], enabled: true };
    const errs = errorsOf(edit((f) => f.rules.push(rule))).join();
    expect(errs).toMatch(/starts at a step that doesn't exist/);
    expect(errs).toMatch(/moves rows to a step that doesn't exist/);
  });

  it("a date rule counts from a date column or the day the row was added, never both", () => {
    const base = { id: "r1", text: "Remind", reading: { when: "w", then: "t" }, actions: [{ kind: "notify" as const, columns: ["owner"], message: "Remind" }], enabled: true };
    const withTrigger = (trigger: object) => errorsOf(edit((f) => f.rules.push({ ...base, trigger: { sheet: "contracts", ...trigger } as never })));
    expect(withTrigger({ kind: "date_reached", from: "added", offsetDays: 14 })).toEqual([]);
    expect(withTrigger({ kind: "date_reached", from: "added", date: "start" }).join()).toMatch(/isn't a date/);
    expect(withTrigger({ kind: "enters_step", step: "draft", from: "added" }).join()).toMatch(/only a date rule/);
  });

  it("the row itself fills only a link back to its sheet, and only in a field map", () => {
    const f = edit((f) => {
      f.sheets.push({ id: "notes", name: "Notes", kind: "list", titleColumn: "text", columns: [{ id: "text", name: "Text", type: "text" }, { id: "contract", name: "Contract", type: "link", link: { sheet: "contracts" } }] });
      for (const r of f.roles) if (r.scope !== "all") r.scopeColumns = { ...r.scopeColumns, notes: { via: "contract", column: "owner" } };
      f.rules.push({
        id: "r1",
        text: "Add a note",
        reading: { when: "w", then: "t" },
        trigger: { kind: "row_created", sheet: "contracts" },
        actions: [{ kind: "create_row_in", target: { sheet: "notes" }, map: { contract: { ref: "row" } } }],
        enabled: true,
      });
    });
    expect(errorsOf(f)).toEqual([]);
    const wrong = edit((f) => ((f.rules[0]!.actions[0] as { map: object }).map = { text: { ref: "row" } }), f);
    expect(errorsOf(wrong).join()).toMatch(/isn't a link to Contracts/);
    const inCondition = edit((f) => (f.rules[0]!.condition = { op: "empty", args: [{ ref: "row" }] }), f);
    expect(errorsOf(inCondition).join()).toMatch(/only a rule's field map can/);
  });
});

describe("rules that ask a person, role views and checks", () => {
  const ask = (action: Record<string, unknown>, sheetFile = hiringWithSteps()) =>
    errorsOf(edit((f) => f.rules.push({ id: "ask", text: "t", reading: { when: "w", then: "t" }, trigger: { kind: "row_created", sheet: "candidates" }, actions: [{ kind: "ask_person", ...action } as never], enabled: true }), sheetFile)).join();

  it("asks someone a link away, until a column is filled, or for a decision", () => {
    expect(ask({ step: "offer", column: "manager", via: "opening", label: "Send the offer" })).toBe("");
    expect(ask({ until: "name", managerOf: "referrer" })).toBe("");
    expect(ask({ person: PEOPLE.wade, decision: { column: "approval", approve: "approved", decline: "declined" } })).toBe("");
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ["no way to end the wait", { column: "referrer" }, /says how long the row waits/],
    ["a column that isn't on the linked row", { step: "offer", column: "ghost", via: "opening" }, /isn't a person column on the linked row/],
    ["a link that isn't one", { step: "offer", column: "manager", via: "name" }, /isn't a link column/],
    ["a decision column without the options", { person: PEOPLE.wade, decision: { column: "approval", approve: "yes", decline: "declined" } }, /choice column with an approve and a decline/],
    ["waiting for a column that doesn't exist", { until: "ghost", column: "referrer" }, /waits for a column that doesn't exist/],
  ])("refuses %s", (_, action, msg) => expect(ask(action)).toMatch(msg));

  it("checks a view's sheet, columns and form", () => {
    const view = (v: Record<string, unknown>) =>
      errorsOf(edit((f) => (f.roles[1]!.view = { sheet: "contracts", line: "The contracts you own", columns: [{ column: "customer" }], ...v } as never))).join();
    expect(view({ columns: [{ column: "start", name: "Dates", to: "renews" }, { column: "value", hint: "notice" }], form: ["customer", "value"] })).toBe("");
    expect(view({ sheet: "ghost" })).toMatch(/a sheet the role doesn't see/);
    expect(view({ columns: [{ column: "ghost" }] })).toMatch(/isn't on Contracts/);
    expect(view({ columns: [{ column: "customer", to: "renews" }] })).toMatch(/from one date column to another/);
    expect(view({ form: ["days_left"] })).toMatch(/can't be filled/);
  });

  it("checks a sheet's checks are yes/no conditions", () => {
    const check = (condition: unknown) => errorsOf(edit((f) => (contracts(f).checks = [{ id: "c", name: "Within budget", condition: condition as never }]))).join();
    expect(check({ op: "lte", args: [{ col: "value" }, 10_000_000] })).toBe("");
    expect(check({ col: "value" })).toMatch(/yes\/no condition/);
  });
});

// Hiring with steps, a referrer and a decision column, for rules that ask someone.
function hiringWithSteps(): CapabilityFile {
  const f = hiringFile();
  f.roles = [];
  f.sheets[1]!.columns.push(
    { id: "referrer", name: "Referred by", type: "person" },
    { id: "approval", name: "Offer approval", type: "choice", options: [{ id: "approved", name: "Approved" }, { id: "declined", name: "Declined" }] },
    { id: "stage", name: "Stage", type: "step" },
  );
  f.sheets[1]!.steps = [{ id: "applied", name: "Applied", start: true }, { id: "offer", name: "Offer" }, { id: "hired", name: "Hired", end: "final" }];
  return f;
}

// Openings, Candidates (linked to an opening) and Interviews (linked to a candidate).
function hiringFile(): CapabilityFile {
  return {
    name: "Hiring",
    icon: "briefcase-business",
    sheets: [
      { id: "openings", name: "Openings", kind: "list", titleColumn: "role", columns: [{ id: "role", name: "Role", type: "text" }, { id: "manager", name: "Hiring manager", type: "person" }] },
      { id: "candidates", name: "Candidates", kind: "list", titleColumn: "name", columns: [{ id: "name", name: "Name", type: "text" }, { id: "opening", name: "Opening", type: "link", link: { sheet: "openings" } }] },
      { id: "interviews", name: "Interviews", kind: "list", titleColumn: "candidate", columns: [{ id: "candidate", name: "Candidate", type: "link", link: { sheet: "candidates" } }, { id: "interviewer", name: "Interviewer", type: "person" }] },
    ],
    roles: [
      {
        id: "managers",
        name: "Hiring managers",
        members: { kind: "column", sheet: "openings", column: "manager" },
        can: ["see", "move_steps"],
        scope: "team",
        scopeColumns: { openings: { column: "manager" }, candidates: { via: "opening", column: "manager" }, interviews: { column: "interviewer" } },
      },
    ],
    rules: [],
    later: [],
  };
}
