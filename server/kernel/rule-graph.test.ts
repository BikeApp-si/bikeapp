import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditEntries } from "@/db/schema";
import { kernelWorkspace } from "@/tests/kernel";
import { deleteCapability, deleteImpact, getFile, saveVersion } from "./capabilities";
import { findLoop } from "./rule-graph";
import type { CapabilityFile, Rule } from "./schema/file";

const rule = (id: string, r: Omit<Rule, "id" | "text" | "reading" | "enabled">): Rule => ({ id, text: `Rule ${id}.`, reading: { when: "w", then: "t" }, enabled: true, ...r });

// Candidates (with steps) and Plans, each a capability, joined by rules in both directions.
const hiring = (rules: Rule[]): CapabilityFile => ({
  name: "Hiring",
  icon: "briefcase",
  sheets: [
    {
      id: "candidates",
      name: "Candidates",
      kind: "list",
      titleColumn: "name",
      columns: [{ id: "name", name: "Name", type: "text" }, { id: "note", name: "Note", type: "text" }, { id: "stage", name: "Stage", type: "step" }],
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

describe("findLoop", () => {
  it("finds a rule that sets itself off again through another capability", () => {
    expect(findLoop(new Map([["H", hiring([START])], ["O", onboarding([BACK])]]))).toBe(
      "These rules would set each other off in a circle: “Rule start” (Hiring) → “Rule back” (Onboarding) → “Rule start” (Hiring).",
    );
  });

  it("lets a hand-off go one way, and leaves a circle inside one capability to the 3-level limit", () => {
    expect(findLoop(new Map([["H", hiring([START])], ["O", onboarding([])]]))).toBeNull();
    const self = rule("self", { trigger: { kind: "field_changed", sheet: "candidates", field: "note" }, actions: [{ kind: "update_row_in", target: { sheet: "candidates" }, via: "name", map: { note: "x" } }] });
    expect(findLoop(new Map([["H", hiring([self])]]))).toBeNull();
  });

  it("ignores rules that are switched off", () => {
    expect(findLoop(new Map([["H", hiring([START])], ["O", onboarding([{ ...BACK, enabled: false }])]]))).toBeNull();
  });
});

describe("saving, deleting and connections", () => {
  let k: Awaited<ReturnType<typeof kernelWorkspace>>;
  let h: string;
  let o: string;
  const fix = (f: CapabilityFile) => JSON.parse(JSON.stringify(f).replaceAll('"H"', JSON.stringify(h)).replaceAll('"O"', JSON.stringify(o)));

  beforeAll(async () => {
    k = await kernelWorkspace();
    h = await k.create(hiring([]));
    o = await k.create(fix(onboarding([])));
  });

  it("refuses to save a file that closes a circle, and writes rule.saved for each rule added or changed", async () => {
    await k.as("ada", (tx, c) => saveVersion(tx, c, h, fix(hiring([START])), { source: "customize", event: "customize.saved" }));
    await expect(k.as("ada", (tx, c) => saveVersion(tx, c, o, fix(onboarding([BACK])), { source: "customize", event: "customize.saved" }))).rejects.toThrow(/set each other off in a circle/);
    const saved = await k.as("ada", (tx) => tx.select().from(auditEntries).where(and(eq(auditEntries.event, "rule.saved"), eq(auditEntries.capabilityId, h))));
    expect(saved.map((e) => e.details)).toEqual([{ version: 2, rule: "Rule start.", change: "added" }]);
  });

  it("refuses deleting a capability another one links to, and says which column (X7)", async () => {
    const impact = await k.as("ada", (tx, c) => deleteImpact(tx, c, h));
    expect(impact.linkedFrom).toEqual([{ capability: "Onboarding", sheet: "Plans", column: "Candidate" }]);
    expect(impact.refused).toBe("Hiring can’t be deleted while Onboarding links to it in its Candidate column (Plans).");
    await expect(k.as("ada", (tx, c) => deleteCapability(tx, c, h, "Hiring"))).rejects.toThrow(impact.refused!);
  });

  it("deleting lists the connections into and out of it, then stops the ones that come in (X7)", async () => {
    const impact = await k.as("ada", (tx, c) => deleteImpact(tx, c, o));
    expect(impact.connections).toEqual([{ direction: "into", capability: "Hiring", text: "Rule start." }]);
    await k.as("ada", (tx, c) => deleteCapability(tx, c, o, "Onboarding"));
    const now = await k.as("ada", (tx) => getFile(tx, h));
    expect(now).toMatchObject({ version: 3 });
    expect(now!.file.rules).toEqual([]);
    const removed = await k.as("ada", (tx) => tx.select().from(auditEntries).where(and(eq(auditEntries.event, "rule.saved"), eq(auditEntries.capabilityId, h))));
    expect(removed.at(-1)!.details).toEqual({ version: 3, rule: "Rule start.", change: "removed" });
  });
});
