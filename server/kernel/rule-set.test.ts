import { describe, expect, it } from "vitest";
import { findLoop } from "./rule-graph";
import { checkRule, findRule, rulesOf, rulesOn, ruleSet, ruleSetOf, sourceKey, type RuleEntry } from "./rule-set";
import type { CapabilityFile, Rule } from "./schema/file";

const rule = (id: string, r: Omit<Rule, "id" | "text" | "reading" | "enabled">): Rule => ({ id, text: `Rule ${id}.`, reading: { when: "w", then: "t" }, enabled: true, ...r });

const hiring = (rules: Rule[]): CapabilityFile => ({
  name: "Hiring",
  icon: "briefcase",
  sheets: [
    {
      id: "candidates",
      name: "Candidates",
      kind: "list",
      titleColumn: "name",
      columns: [{ id: "name", name: "Name", type: "text" }, { id: "stage", name: "Stage", type: "step" }],
      steps: [{ id: "applied", name: "Applied", start: true }, { id: "hired", name: "Hired", end: "final" }],
    },
  ],
  roles: [],
  rules,
  later: [],
});
const onboarding = (rules: Rule[]): CapabilityFile => ({
  name: "Onboarding",
  icon: "user-check",
  sheets: [{ id: "plans", name: "Plans", kind: "list", titleColumn: "name", columns: [{ id: "name", name: "Name", type: "text" }, { id: "candidate", name: "Candidate", type: "link", link: { capability: "H", sheet: "candidates" } }] }],
  roles: [],
  rules,
  later: [],
});

const START = rule("start", { trigger: { kind: "enters_step", sheet: "candidates", step: "hired" }, actions: [{ kind: "create_row_in", target: { capability: "O", sheet: "plans" }, map: { name: { col: "name" } } }] });
const BACK = rule("back", { trigger: { kind: "row_created", sheet: "plans" }, actions: [{ kind: "update_row_in", target: { capability: "H", sheet: "candidates" }, via: "candidate", map: { stage: "hired" } }] });
const NOTE = rule("note", { trigger: { kind: "row_created", sheet: "candidates" }, actions: [{ kind: "move_to_step", step: "applied" }] });

describe("the rule list", () => {
  const files = new Map([
    ["H", { version: 3, file: hiring([START, NOTE]) }],
    ["O", { version: 1, file: onboarding([BACK]) }],
  ]);

  it("lists every rule with its source, app by app in file order", () => {
    const list = ruleSet(files);
    expect(list.map((e) => [sourceKey(e.source), e.source.version, e.capabilityId, e.rule.id])).toEqual([
      ["capability:H", 3, "H", "start"],
      ["capability:H", 3, "H", "note"],
      ["capability:O", 1, "O", "back"],
    ]);
  });

  it("finds the rules on a sheet, of an app, and one rule by its stored source", () => {
    const list = ruleSet(files);
    expect(rulesOn(list, "H", "candidates").map((e) => e.rule.id)).toEqual(["start", "note"]);
    expect(rulesOn(list, "O", "candidates")).toEqual([]);
    expect(rulesOf(list, "O").map((e) => e.rule.id)).toEqual(["back"]);
    expect(findRule(list, "capability:O", "back")?.capabilityId).toBe("O");
    // A rule id is only unique within its source.
    expect(findRule(list, "capability:H", "back")).toBeUndefined();
  });

  it("the loop check reads the list it is given, not only the files' rules", () => {
    const noBack = new Map([["H", hiring([START])], ["O", onboarding([])]]);
    expect(findLoop(noBack)).toBeNull();
    // The same rule handed in from a second source closes the circle.
    const extra: RuleEntry = { source: { kind: "capability", capabilityId: "O", version: 99 }, capabilityId: "O", rule: BACK };
    expect(findLoop(noBack, [...ruleSetOf(noBack), extra])).toBe(
      "These rules would set each other off in a circle: “Rule start” (Hiring) → “Rule back” (Onboarding) → “Rule start” (Hiring).",
    );
  });

  it("checks one rule against the app its trigger is on", () => {
    const plain = new Map([...files].map(([id, f]) => [id, { file: f.file }]));
    expect(checkRule(plain, new Set(), "O", BACK)).toEqual([]);
    expect(checkRule(plain, new Set(), "H", BACK)).toEqual(["Rule “Rule back.”: starts on a sheet that doesn't exist."]);
    expect(checkRule(plain, new Set(), "X", BACK)).toEqual(["That app doesn't exist."]);
  });
});
