import { beforeAll, describe, expect, it } from "vitest";
import { auditEntries, rows, waits } from "@/db/schema";
import { kernelWorkspace } from "@/tests/kernel";
import { createCapability } from "./capabilities";
import { previewRule } from "./preview";
import type { CapabilityFile, Rule } from "./schema/file";
import { importRows, moveStep } from "./rows";

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let cap: string;
const NOW = new Date("2026-10-27T15:00:00Z");

const file: CapabilityFile = {
  name: "Customer contracts",
  icon: "file",
  sheets: [
    {
      id: "contracts",
      name: "Contracts",
      kind: "list",
      titleColumn: "customer",
      row: { one: "contract", many: "contracts" },
      columns: [
        { id: "customer", name: "Customer", type: "text", required: true },
        { id: "value", name: "Value a year", type: "money" },
        { id: "notice_date", name: "Notice date", type: "date" },
        { id: "owner", name: "Owner", type: "person" },
        { id: "status", name: "Status", type: "step" },
      ],
      steps: [{ id: "draft", name: "Draft", start: true }, { id: "active", name: "Active" }, { id: "due", name: "Renewal due" }, { id: "renewed", name: "Renewed", end: "final" }],
    },
  ],
  roles: [{ id: "all", name: "All", members: { kind: "everyone" }, can: ["see", "add", "move_steps"], scope: "all" }],
  rules: [],
  later: [],
};

const rule = (r: Omit<Rule, "id" | "text" | "reading" | "enabled">): Rule => ({ id: "new", text: "t", reading: { when: "w", then: "t" }, enabled: true, ...r });
const preview = (r: Rule, who: "ada" | "maya" = "ada") => k.as(who, (tx, c) => previewRule(tx, c, cap, r), NOW);

beforeAll(async () => {
  k = await kernelWorkspace();
  cap = await k.as("ada", (tx, c) => createCapability(tx, c, file, { source: "build", at: new Date("2026-06-01T12:00:00Z") })).then((r) => r.id);
  const ids = await k.as("ada", (tx, c) =>
    importRows(tx, c, cap, "contracts", [
      { values: { customer: "Northwind", value: 3_840_000, notice_date: "2026-10-15", owner: k.id.rita, status: "active" } },
      { values: { customer: "Orbit Health", value: 1_440_000, notice_date: "2026-12-10", owner: k.id.rita, status: "active" } },
      { values: { customer: "Brightline", value: 5_760_000, notice_date: "2026-11-04", owner: k.id.priya, status: "active" } },
      { values: { customer: "Old one", value: 100_000, notice_date: "2026-03-01", owner: k.id.priya, status: "active" } },
    ], { source: "c.csv", at: new Date("2026-07-01T12:00:00Z") }),
  );
  await k.as("ada", (tx, c) => moveStep(tx, c, ids[0]!, "due"), new Date("2026-10-22T15:00:00Z"));
});

describe("previewRule", () => {
  it("replays a date rule over the last 90 days and says what it would have done, writing nothing", async () => {
    const counts = () => k.as("ada", async (tx) => [await tx.$count(rows), await tx.$count(auditEntries), await tx.$count(waits)]);
    const before = await counts();
    const p = await preview(rule({ trigger: { kind: "date_reached", sheet: "contracts", date: "notice_date", offsetDays: -60 }, actions: [{ kind: "ask_person", column: "owner", step: "due" }] }));
    // Northwind Aug 16, Brightline Sep 5, Orbit Oct 11; the old one (Jan 1) is outside the 90 days.
    expect(p.items.map((i) => [i.title, i.on, i.did])).toEqual([
      ["Northwind", "2026-08-16", ["ask Rita Gomez at Renewal due"]],
      ["Brightline", "2026-09-05", ["ask Priya Nair at Renewal due"]],
      ["Orbit Health", "2026-10-11", ["ask Rita Gomez at Renewal due"]],
    ]);
    expect(p.summary).toBe("On your last 90 days, this rule would have moved 3 contracts to Renewal due for someone to act on.");
    expect(await counts()).toEqual(before);
  });

  it("applies the condition, and reads moves from the Audit log", async () => {
    const p = await preview(rule({ trigger: { kind: "enters_step", sheet: "contracts", step: "due" }, condition: { op: "gt", args: [{ col: "value" }, 3_000_000] }, actions: [{ kind: "notify", people: [k.id.ada], message: "m" }] }));
    expect(p.items.map((i) => [i.title, i.on])).toEqual([["Northwind", "2026-10-22"]]);
    expect(p.summary).toBe("On your last 90 days, this rule would have sent a reminder about 1 contract.");
  });

  it("says when it wouldn't have run, refuses a rule that isn't valid, and is for admins only", async () => {
    expect((await preview(rule({ trigger: { kind: "row_created", sheet: "contracts" }, actions: [{ kind: "move_to_step", step: "active" }] }))).summary).toBe("On your last 90 days, this rule wouldn't have run.");
    await expect(preview(rule({ trigger: { kind: "row_created", sheet: "ghost" }, actions: [{ kind: "move_to_step", step: "active" }] }))).rejects.toThrow("That rule isn't valid.");
    await expect(preview(rule({ trigger: { kind: "row_created", sheet: "contracts" }, actions: [{ kind: "move_to_step", step: "active" }] }), "maya")).rejects.toThrow(/Only admins/);
  });
});
