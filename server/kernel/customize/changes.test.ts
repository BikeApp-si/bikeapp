import { describe, expect, it } from "vitest";
import { contractsFile, PEOPLE } from "../fixtures";
import type { CapabilityFile, Rule } from "../schema/file";
import { applyChanges, ChangeError, type Change } from "./changes";
import { checkCustomize, stepKey } from "./check";
import { usesOf } from "./deps";

// Customize changes as the kernel applies and checks them (6c–6l), on small files: no database.

const CONTRACTS = "10000000-0000-4000-8000-00000000000c";
const HIRING = "10000000-0000-4000-8000-00000000000a";
const ONBOARDING = "10000000-0000-4000-8000-00000000000b";
const LENA = "00000000-0000-4000-8000-000000000003";
const people = new Set([...Object.values(PEOPLE), LENA]);

const REMIND: Rule = {
  id: "remind_owner",
  text: "60 days before a contract’s notice date, move it to Renewal due and remind its owner.",
  reading: { when: "w", then: "t" },
  trigger: { kind: "date_reached", sheet: "contracts", date: "renews", offsetDays: -60 },
  actions: [{ kind: "notify", columns: ["owner"], message: "Renewal due." }],
  enabled: true,
};

// Contracts without Legal review, as before 6c, with its reminder and an add action.
function contracts(): CapabilityFile {
  const f = contractsFile([PEOPLE.wade, PEOPLE.krishna]);
  f.sheets[0]!.steps = f.sheets[0]!.steps!.filter((s) => s.id !== "legal");
  f.sheets[0]!.addAction = "New contract";
  f.roles[1]!.view = { sheet: "contracts", line: "The contracts you own", columns: [{ column: "customer" }, { column: "status" }] };
  f.rules = [REMIND];
  return f;
}

function hiring(): CapabilityFile {
  return {
    name: "Hiring",
    icon: "briefcase-business",
    sheets: [
      {
        id: "openings",
        name: "Openings",
        kind: "list",
        titleColumn: "role",
        columns: [
          { id: "role", name: "Role", type: "text", required: true },
          { id: "status", name: "Status", type: "step" },
        ],
        steps: [{ id: "open", name: "Open", start: true }, { id: "filled", name: "Filled", end: "final" }],
      },
      {
        id: "candidates",
        name: "Candidates",
        kind: "list",
        row: { one: "candidate", many: "candidates" },
        titleColumn: "name",
        columns: [
          { id: "name", name: "Name", type: "text", required: true },
          { id: "opening", name: "Opening", type: "link", link: { sheet: "openings" } },
          { id: "stage", name: "Stage", type: "step" },
        ],
        steps: [{ id: "offer", name: "Offer", start: true }, { id: "hired", name: "Hired", end: "final" }, { id: "rejected", name: "Rejected", end: "exit" }],
      },
    ],
    roles: [{ id: "recruiting", name: "Recruiting", members: { kind: "people", people: [PEOPLE.wade] }, can: ["see", "add", "edit", "move_steps", "customize"], scope: "all" }],
    rules: [
      {
        id: "start_onboarding",
        text: "When a candidate is Hired, start their onboarding plan.",
        reading: { when: "w", then: "t" },
        trigger: { kind: "enters_step", sheet: "candidates", step: "hired" },
        actions: [{ kind: "create_row_in", target: { capability: ONBOARDING, sheet: "plans" }, map: { name: { col: "name" } } }],
        enabled: true,
      },
      {
        id: "fill_opening",
        text: "When a candidate is Hired, their opening moves to Filled.",
        reading: { when: "w", then: "t" },
        trigger: { kind: "enters_step", sheet: "candidates", step: "hired" },
        actions: [{ kind: "update_row_in", target: { sheet: "openings" }, via: "opening", map: { status: "filled" } }],
        enabled: true,
      },
    ],
    later: [],
  };
}

const onboarding = (): CapabilityFile => ({
  name: "Onboarding",
  icon: "user-check",
  sheets: [{ id: "plans", name: "Plans", kind: "list", titleColumn: "name", columns: [{ id: "name", name: "Name", type: "text", required: true }] }],
  roles: [],
  rules: [],
  later: [],
});

const world = () => new Map([[CONTRACTS, contracts()], [HIRING, hiring()], [ONBOARDING, onboarding()]]);
const none = new Map<string, number>();
const check = (capId: string, changes: Change[], counts = none) => {
  const w = world();
  return checkCustomize(w, new Map([[capId, applyChanges(w.get(capId)!, changes)]]), people, counts);
};

// 6c: Legal review between Signed and Active for contracts over $50,000, Lena in Contract managers, and the
// reminder moved from 60 to 90 days.
const SIX_C: Change[] = [
  { kind: "add_step", sheet: "contracts", after: "signed", step: { id: "legal_review", name: "Legal review", onlyWhen: { op: "gt", args: [{ col: "value" }, 5_000_000] } } },
  { kind: "add_person_to_role", role: "managers", person: LENA },
  { kind: "set_rule", rule: { ...REMIND, text: "90 days before a contract’s notice date, move it to Renewal due and remind its owner.", trigger: { ...REMIND.trigger, offsetDays: -90 } } },
];

describe("Customize changes", () => {
  it("6c's three changes give the file the text previews, and pass every check", () => {
    const before = contracts();
    const after = applyChanges(before, SIX_C);
    expect(after.sheets[0]!.steps!.map((s) => s.name)).toEqual(["Draft", "Signed", "Legal review", "Active", "Ended", "Renewed"]);
    expect(after.roles[0]!.members).toEqual({ kind: "people", people: [PEOPLE.wade, PEOPLE.krishna, LENA] });
    expect(after.rules).toHaveLength(1);
    expect(after.rules[0]!.trigger.offsetDays).toBe(-90);
    expect(before.sheets[0]!.steps).toHaveLength(5); // the file passed in is never changed
    expect(check(CONTRACTS, SIX_C)).toEqual([]);
  });

  it("is pure: the same file and changes give the same file", () => {
    const first = JSON.stringify(applyChanges(contracts(), SIX_C));
    for (let i = 0; i < 20; i++) expect(JSON.stringify(applyChanges(contracts(), SIX_C))).toBe(first);
  });

  it("renames an add action and changes a role view's columns, with the same checks", () => {
    const changes: Change[] = [
      { kind: "set_labels", sheet: "contracts", addAction: "Add a contract", buttons: { renewed: "Mark renewed" } },
      { kind: "set_role_view", role: "owners", view: { sheet: "contracts", line: "The contracts you own", columns: [{ column: "customer" }, { column: "renews" }, { column: "value" }, { column: "status" }] } },
    ];
    const after = applyChanges(contracts(), changes);
    expect(after.sheets[0]!.addAction).toBe("Add a contract");
    expect(after.roles[1]!.view!.columns.map((c) => c.column)).toEqual(["customer", "renews", "value", "status"]);
    expect(check(CONTRACTS, changes)).toEqual([]);
    // A view of a column that doesn't exist is refused like any other file problem.
    const bad: Change[] = [{ kind: "set_role_view", role: "owners", view: { sheet: "contracts", line: "Yours", columns: [{ column: "colour" }] } }];
    expect(check(CONTRACTS, bad).join()).toMatch(/Contract owners › view/);
  });

  it("sets hint columns, the default sort, sheet checks and who may move a step", () => {
    const changes: Change[] = [
      { kind: "set_default_sort", sheet: "contracts", sort: { column: "renews", dir: "asc" } },
      { kind: "set_hint_column", sheet: "contracts", column: "days_left", hintFor: "renews" },
      { kind: "add_sheet_check", sheet: "contracts", check: { id: "has_value", name: "Has a value", condition: { op: "gt", args: [{ col: "value" }, 0] } } },
      { kind: "set_step_movers", sheet: "contracts", step: "active", moveIn: "not_submitter" },
    ];
    const after = applyChanges(contracts(), changes);
    expect(after.sheets[0]!.sort).toEqual({ column: "renews", dir: "asc" });
    expect(after.sheets[0]!.columns.find((c) => c.id === "days_left")!.hintFor).toBe("renews");
    expect(after.sheets[0]!.steps!.find((s) => s.id === "active")!.moveIn).toBe("not_submitter");
    expect(check(CONTRACTS, changes)).toEqual([]);
  });

  it("says plainly when a change names something that isn't there", () => {
    expect(() => applyChanges(contracts(), [{ kind: "add_step", sheet: "contracts", after: "approved", step: { id: "x", name: "X" } }])).toThrow(ChangeError);
    expect(() => applyChanges(contracts(), [{ kind: "add_person_to_role", role: "owners", person: LENA }])).toThrow(/whoever a column names/);
  });
});

describe("what Customize refuses", () => {
  it("removing a step that holds rows, with how many; renaming it is fine (6h)", () => {
    const w = world();
    const removed = structuredClone(w.get(HIRING)!);
    removed.sheets[1]!.steps = removed.sheets[1]!.steps!.filter((s) => s.id !== "hired");
    const counts = new Map([[stepKey(HIRING, "candidates", "hired"), 5]]);
    const problems = checkCustomize(w, new Map([[HIRING, removed]]), people, counts);
    expect(problems[0]).toBe("Hired has 5 candidates, so it can't be removed in this version. It can be renamed instead.");
    expect(check(HIRING, [{ kind: "rename", sheet: "candidates", step: "hired", name: "Offer accepted" }], counts)).toEqual([]);
  });

  it("a removed column another capability reads, named in that capability", () => {
    const w = world();
    const after = structuredClone(w.get(HIRING)!);
    after.sheets[1]!.columns = after.sheets[1]!.columns.filter((c) => c.id !== "name");
    after.sheets[1]!.titleColumn = "opening";
    const problems = checkCustomize(w, new Map([[HIRING, after]]), people, none);
    expect(problems).toContain("Candidates would lose its Name column.");
  });

  it("a rule that would set itself off through another capability", () => {
    const back: Change = {
      kind: "set_rule",
      rule: {
        id: "back",
        text: "When a plan is added, move the candidate on.",
        reading: { when: "w", then: "t" },
        trigger: { kind: "row_created", sheet: "plans" },
        actions: [{ kind: "create_row_in", target: { capability: HIRING, sheet: "candidates" }, map: { name: { col: "name" }, stage: "hired" } }],
        enabled: true,
      },
    };
    const w = world();
    const h = applyChanges(w.get(HIRING)!, []);
    h.rules[0]!.trigger = { kind: "row_created", sheet: "candidates" };
    const problems = checkCustomize(new Map([...w, [HIRING, h]]), new Map([[ONBOARDING, applyChanges(w.get(ONBOARDING)!, [back])]]), people, none);
    expect(problems.join()).toMatch(/set each other off in a circle/);
  });

  it("someone who isn't in People", () => {
    expect(check(CONTRACTS, [{ kind: "add_person_to_role", role: "managers", person: "00000000-0000-4000-8000-0000000000ff" }]).join()).toMatch(/isn't in People/);
  });
});

describe("the dependency check", () => {
  it("lists the connection and the rule that start at Hired (6h)", () => {
    expect(usesOf(world(), { capabilityId: HIRING, sheetId: "candidates", step: "hired" })).toEqual([
      { capabilityId: HIRING, kind: "connection", ruleId: "start_onboarding", text: "When a candidate is Hired, start their onboarding plan." },
      { capabilityId: HIRING, kind: "rule", ruleId: "fill_opening", text: "When a candidate is Hired, their opening moves to Filled." },
    ]);
  });

  it("lists what reads a step through a field map, and what reads a column", () => {
    expect(usesOf(world(), { capabilityId: HIRING, sheetId: "openings", step: "filled" }).map((u) => u.ruleId)).toEqual(["fill_opening"]);
    expect(usesOf(world(), { capabilityId: CONTRACTS, sheetId: "contracts", column: "renews" }).map((u) => u.ruleId)).toEqual(["remind_owner"]);
    expect(usesOf(world(), { capabilityId: CONTRACTS, sheetId: "contracts", step: "draft" })).toEqual([]);
  });
});
