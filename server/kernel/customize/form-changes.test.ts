import { describe, expect, it } from "vitest";
import { contractsFile, PEOPLE } from "../fixtures";
import { defaultForm } from "../form";
import type { CapabilityFile, Rule } from "../schema/file";
import { validateFile } from "../schema/validate";
import { applyChanges } from "./changes";
import { checkCustomize } from "./check";
import { compileCustomize } from "./compile";
import type { CustomizeChange } from "./draft";

// The form through Customize (0.3, M17b): the sheet's tabs and quick questions, and questions shown only sometimes,
// written by name and checked like any change; a rule for new rows can't wait for a question that's asked only
// sometimes; new capabilities get tabs from a fixed rule.

const CAP = "10000000-0000-4000-8000-00000000000c";
const people = new Set(Object.values(PEOPLE));
const file = () => contractsFile([PEOPLE.wade, PEOPLE.krishna]);
const world = (f: CapabilityFile = file()) => ({ capId: CAP, files: new Map([[CAP, f]]), people: new Map<string, string>() });
const base = { sheet: "Contracts", new_sheet: null, column: null, step: null, after: null, rename: null, movers: null, role: null, person: null, rule: null, view: null, labels: null, hint: null, sort: null, check: null, form: null, show_when: null, access: null, link: null, explain: "x", part: "x" };
const change = (c: Partial<CustomizeChange>) => ({ ...base, ...c }) as CustomizeChange;
const SPLIT = change({
  kind: "set_form",
  form: {
    tabs: [
      { name: "Basics", sections: [{ name: null, columns: ["Customer", "Value a year", "Owner"] }] },
      { name: "Dates", sections: [{ name: null, columns: ["Start", "Renews on", "Notice"] }] },
    ],
    quick: ["Start"],
  },
});

describe("set_form", () => {
  it("lays out the form by question names, with the questions asked when a row is added", () => {
    const c = compileCustomize([SPLIT], world());
    expect(c.problems).toEqual([]);
    expect(c.words[0]!.where).toBe("Contracts form");
    const after = applyChanges(file(), c.changes);
    expect(after.sheets[0]!.form).toEqual({
      tabs: [
        { name: "Basics", sections: [{ name: null, columns: ["customer", "value", "owner"] }] },
        { name: "Dates", sections: [{ name: null, columns: ["start", "renews", "notice"] }] },
      ],
      quick: ["start"],
    });
    expect(checkCustomize(new Map([[CAP, file()]]), new Map([[CAP, after]]), people, new Map())).toEqual([]);
  });
  it("names an unknown question plainly, and a question in two tabs is refused", () => {
    expect(compileCustomize([change({ kind: "set_form", form: { tabs: [{ name: "A", sections: [{ name: null, columns: ["Colour"] }] }], quick: null } })], world()).problems).toEqual([
      "Customer contracts › Contracts: there is no question “Colour”.",
    ]);
    const twice = compileCustomize(
      [change({ kind: "set_form", form: { tabs: [{ name: "A", sections: [{ name: null, columns: ["Start"] }] }, { name: "B", sections: [{ name: null, columns: ["Start"] }] }], quick: null } })],
      world(),
    );
    const after = applyChanges(file(), twice.changes);
    expect(checkCustomize(new Map([[CAP, file()]]), new Map([[CAP, after]]), people, new Map()).join()).toMatch(/more than one place/);
  });
  it("“only ask for the customer and the value”: an empty quick list takes the extra ones away", () => {
    const split = applyChanges(file(), compileCustomize([SPLIT], world()).changes);
    const only = compileCustomize([change({ kind: "set_form", form: { tabs: SPLIT.form!.tabs, quick: [] } })], world(split));
    expect(applyChanges(split, only.changes).sheets[0]!.form!.quick).toBeUndefined();
  });
});

describe("set_show_when", () => {
  const OVER = '{"op":"gt","args":[{"col":"Value a year"},50000]}';
  it("shows a question only when its condition, written with names, holds; null shows it always again", () => {
    const c = compileCustomize([change({ kind: "set_show_when", show_when: { column: "Start", condition: OVER } })], world());
    expect(c.problems).toEqual([]);
    expect(c.words[0]!.where).toBe("Contracts sheet › Start");
    const after = applyChanges(file(), c.changes);
    expect(after.sheets[0]!.columns.find((x) => x.id === "start")!.showWhen).toEqual({ op: "gt", args: [{ col: "value" }, 5_000_000] });
    const back = compileCustomize([change({ kind: "set_show_when", show_when: { column: "Start", condition: null } })], world(after));
    expect(applyChanges(after, back.changes).sheets[0]!.columns.find((x) => x.id === "start")!.showWhen).toBeUndefined();
  });
  it("refuses a condition that isn't yes or no, and a question that doesn't exist", () => {
    const notYesNo = applyChanges(file(), compileCustomize([change({ kind: "set_show_when", show_when: { column: "Start", condition: '{"col":"Value a year"}' } })], world()).changes);
    expect(checkCustomize(new Map([[CAP, file()]]), new Map([[CAP, notYesNo]]), people, new Map()).join()).toMatch(/yes\/no condition/);
    expect(compileCustomize([change({ kind: "set_show_when", show_when: { column: "Colour", condition: OVER } })], world()).problems.join()).toMatch(/no question “Colour”/);
  });
});

describe("a rule for new rows can't wait for a question asked only sometimes", () => {
  const waits: Rule = {
    id: "signed_with_start",
    text: "A contract added with its start is Signed.",
    reading: { when: "w", then: "t" },
    trigger: { kind: "row_created", sheet: "contracts" },
    condition: { op: "not", args: [{ op: "empty", args: [{ col: "start" }] }] },
    actions: [{ kind: "move_to_step", step: "signed" }],
    enabled: true,
  };
  const withRule = (rule: Rule) => {
    const f = file();
    f.rules = [rule];
    f.sheets[0]!.columns.find((c) => c.id === "start")!.showWhen = { op: "gt", args: [{ col: "value" }, 5_000_000] };
    const r = validateFile(f, { people });
    return r.ok ? "" : r.errors.join(" ");
  };
  it("is refused with the reason, so the AI changes the rule with it", () => {
    expect(withRule(waits)).toMatch(/waits for Start to be filled in, but Start is asked only sometimes/);
  });
  it("is fine once the rule also says what happens when it isn't asked", () => {
    expect(withRule({ ...waits, condition: { op: "or", args: [waits.condition!, { op: "lte", args: [{ col: "value" }, 5_000_000] }] } })).toBe("");
  });
});

describe("tabs for a new capability", () => {
  it("Basics, Dates and Documents for a long sheet; none for a short one", () => {
    const sheet = file().sheets[0]!;
    sheet.columns.push({ id: "signed_copy", name: "Signed copy", type: "file" });
    expect(defaultForm(sheet)?.tabs.map((t) => t.name)).toEqual(["Basics", "Dates", "Documents"]);
    expect(defaultForm({ ...sheet, columns: sheet.columns.slice(0, 4) })).toBeUndefined();
  });
});
