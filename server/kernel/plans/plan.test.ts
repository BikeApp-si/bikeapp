import { beforeAll, describe, expect, it } from "vitest";
import { people } from "@/db/schema";
import { seed } from "@/seed";
import { load } from "../context";
import type { CapabilityFile } from "../schema/file";
import { withWorkspace } from "../tx";
import type { DraftAlsoChange, DraftCapability } from "./draft";
import { alsoChanges, billRules, bills, col, contractRules, contracts, J, stp } from "./fixtures";
import { checkPlan, type PlanInput } from "./plan";

// Plans as the AI writes them (by name), compiled and checked against Fernwood's files: 5c's Customer
// contracts on a Fernwood without it, and 5j's Supplier bills with its 3 Also changes.

let files: Map<string, CapabilityFile>; // Fernwood without Customer contracts
let emails: Map<string, string>;
const capId = (name: string) => [...files].find(([, f]) => f.name === name)![0];
const NEW = "00000000-0000-4000-8000-000000000005";

beforeAll(async () => {
  const ws = (await seed()).fernwood.workspaceId;
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    const loaded = await load(tx);
    files = new Map([...loaded.files].filter(([, f]) => f.file.name !== "Customer contracts").map(([id, f]) => [id, f.file]));
    emails = new Map((await tx.select({ id: people.id, email: people.email }).from(people)).map((p) => [p.email, p.id]));
  });
});

const check = (input: PlanInput) => checkPlan(input, { newId: NEW, files, people: emails });



describe("a plan for a new app", () => {
  it("compiles 5c's Customer contracts: ids from names, defaults, steps, roles and its 2 rules", () => {
    const { file, edited, problems } = check({ capability: contracts, rules: contractRules, alsoChanges: [] });
    expect(problems).toEqual([]);
    expect(edited.size).toBe(0);
    const sheet = file.sheets[0]!;
    expect(sheet.columns.map((c) => c.id)).toEqual(["customer", "value_a_year", "start", "renews_on", "notice", "notice_date", "owner", "signed_contract", "status"]);
    expect(sheet.columns[3]!.default).toEqual({ kind: "expr", expr: { op: "date_add", args: [{ col: "start" }, 1, "years"] } });
    expect(sheet.columns[4]!.default).toEqual({ kind: "value", value: 30 });
    expect(sheet.steps!.map((s) => [s.id, s.end ?? null, s.button ?? null])).toEqual([
      ["draft", null, null], ["signed", null, null], ["active", null, null], ["renewal_due", null, null], ["renewed", "final", "Mark renewed"], ["ended", "exit", "End contract"],
    ]);
    expect(file.roles[0]!.members).toEqual({ kind: "people", people: [emails.get("wade@fernwood.dev"), emails.get("krishna@fernwood.dev")] });
    expect(file.roles[1]).toMatchObject({ members: { kind: "column", sheet: "contracts", column: "owner" }, scope: "own", scopeColumns: { contracts: { column: "owner" } } });
    expect(file.rules.map((r) => r.trigger)).toEqual([
      { kind: "date_reached", sheet: "contracts", date: "notice_date", offsetDays: -60 },
      { kind: "date_reached", sheet: "contracts", date: "notice_date", offsetDays: -30 },
    ]);
    // A step named in a condition becomes its id.
    expect(file.rules[1]!.condition).toEqual({ op: "eq", args: [{ col: "status" }, "renewal_due"] });
  });

  it("reads money in dollars and a choice by name (5f's Legal review and tier)", () => {
    const v2: DraftCapability = structuredClone(contracts);
    const sheet = v2.sheets[0]!;
    sheet.columns.splice(2, 0, col("Customer tier", "choice", { required: true, options: ["Standard", "Enterprise"] }));
    sheet.columns.find((c) => c.name === "Notice")!.default = { kind: "formula", value: J({ op: "if", args: [{ op: "eq", args: [{ col: "Customer tier" }, "Enterprise"] }, 90, 30] }) };
    sheet.steps.splice(1, 0, stp("Legal review", { only_when: J({ op: "gt", args: [{ col: "Value a year" }, 50000] }) }));
    const { file, problems } = check({ capability: v2, rules: contractRules, alsoChanges: [] });
    expect(problems).toEqual([]);
    const s = file.sheets[0]!;
    expect(s.steps![1]).toMatchObject({ id: "legal_review", onlyWhen: { op: "gt", args: [{ col: "value_a_year" }, 5_000_000] } });
    expect(s.columns.find((c) => c.id === "notice")!.default).toEqual({
      kind: "expr",
      expr: { op: "if", args: [{ op: "eq", args: [{ col: "customer_tier" }, "enterprise"] }, 90, 30] },
    });
  });

  it("lists every name, person and app it can't find, in plain words", () => {
    const bad: DraftCapability = structuredClone(contracts);
    bad.roles[0]!.people.push("ghost@fernwood.dev");
    bad.sheets[0]!.columns[3]!.default = { kind: "formula", value: J({ op: "date_add", args: [{ col: "Begins" }, 1, "years"] }) };
    const rules = [{ ...contractRules[1]!, condition: J({ op: "eq", args: [{ col: "Status" }, "Lapsed"] }) }];
    const { problems } = check({ capability: bad, rules, alsoChanges: [] });
    expect(problems.slice(0, 3)).toEqual([
      "Contracts › Renews on: Contracts has no column “Begins”.",
      "Role “Contract managers”: ghost@fernwood.dev isn't in People.",
      "Rule “30 days before the notice date, if it is still in Renewal due, tell Wade and the owner.”: there is no step “Lapsed”.",
    ]);
    // Nothing a person would read as code.
    expect(problems.join(" ")).not.toMatch(/uuid|undefined|null|\{/i);
  });

  it("says plainly when a total doesn't name what it adds up", () => {
    const bad: DraftCapability = structuredClone(contracts);
    bad.sheets[0]!.columns.push(col("Total", "computed", { result: "money", formula: J({ sumOf: { column: "Value a year" } }) }));
    expect(check({ capability: bad, rules: [], alsoChanges: [] }).problems[0]).toBe("Contracts › Total: a total names the sheet and the column it adds up.");
  });

  it("refuses a name that is already an app", () => {
    expect(check({ capability: { ...contracts, name: "Spend" }, rules: [], alsoChanges: [] }).problems).toContain("There is already an app called Spend.");
  });
});

describe("a plan with Also changes (5j)", () => {
  it("compiles Supplier bills and adds to Spend and Tools and budgets, all checked together", () => {
    const { file, edited, restructures, problems } = check({ capability: bills, rules: billRules, alsoChanges });
    expect(problems).toEqual([]);
    expect(restructures).toEqual([]);
    expect(file.rules).toHaveLength(4);
    const spend = edited.get(capId("Spend"))!.after;
    const purchases = spend.sheets.find((s) => s.id === "purchases")!;
    // Billed comes after Received and is now the last step; Received stops being an end.
    expect(purchases.steps!.map((s) => [s.id, s.end ?? null])).toEqual([["submitted", null], ["approved", null], ["ordered", null], ["received", null], ["billed", "final"], ["rejected", "exit"]]);
    expect(spend.sheets.find((s) => s.id === "purchase_lines")!.columns.at(-1)).toEqual({ id: "received_quantity", name: "Received quantity", type: "number" });
    const budgets = edited.get(capId("Tools and budgets"))!.after.sheets.find((s) => s.id === "budgets")!;
    expect(budgets.columns.at(-1)).toEqual({ id: "spent", name: "Spent", type: "computed", result: "money", expr: { sumOf: { capability: NEW, sheet: "bills", column: "amount", by: "budget", steps: ["paid"] } } });
    // Rules read the purchase one link away; money in cents, steps by id, the linked step from Spend's flow.
    expect(file.rules[0]!.condition).toEqual({
      op: "and",
      args: [
        { op: "between", args: [{ col: "amount" }, { op: "mul", args: [{ col: "total", via: "purchase" }, 0.98] }, { op: "mul", args: [{ col: "total", via: "purchase" }, 1.02] }] },
        { op: "eq", args: [{ col: "status", via: "purchase" }, "received"] },
      ],
    });
    expect(file.rules[2]!.condition).toEqual({ op: "gt", args: [{ col: "amount" }, 200_000] });
    expect(file.rules[3]!.actions[0]).toEqual({ kind: "update_row_in", target: { capability: capId("Spend"), sheet: "purchases" }, via: "purchase", map: { status: "billed" } });
    expect(file.roles[1]).toMatchObject({ members: { kind: "everyone" }, scope: "own", scopeColumns: { bills: { column: "requested_by", via: "purchase" } } });
  });

  it("moves the end to a step added after the last one, even when the step says it is an end", () => {
    const billedEnd = alsoChanges.map((c) => (c.change.includes("Billed") ? { ...c, edits: [{ ...c.edits[0]!, step: stp("Billed", { end: "final" }) }] } : c));
    const { edited, problems } = check({ capability: bills, rules: billRules, alsoChanges: billedEnd });
    expect(problems).toEqual([]);
    const steps = [...edited.values()].find((e) => e.after.name === "Spend")!.after.sheets.find((x) => x.id === "purchases")!.steps!;
    expect(steps.filter((x) => x.end === "final").map((x) => x.id)).toEqual(["billed"]);
  });

  it("lets the new app read a column its own Also change adds", () => {
    const withTotal = structuredClone(bills);
    withTotal.sheets[0]!.columns.push(col("Received total", "computed", { result: "money", formula: J({ col: "Received total", via: "Purchase" }) }));
    const addTotal: DraftAlsoChange = {
      capability: "Spend", sheet: "Purchases", change: "Add a Received total column", reason: "So a bill can be checked against what arrived", kind: "add",
      edits: [{ kind: "add_column", sheet: "Purchases", column: col("Received total", "money"), step: null, after: null, role: null, person: null, link: null }],
    };
    const { file, problems } = check({ capability: withTotal, rules: billRules, alsoChanges: [...alsoChanges, addTotal] });
    expect(problems).toEqual([]);
    expect(file.sheets[0]!.columns.at(-1)).toMatchObject({ id: "received_total", expr: { col: "received_total", via: "purchase" } });
  });

  it("refuses an Also change that would take something away, and keeps a restructure apart", () => {
    const restructure: DraftAlsoChange = { capability: "Spend", sheet: "Purchases", change: "Move Supplier into its own sheet", reason: "One record per supplier", kind: "restructure", edits: [] };
    const { restructures, problems } = check({ capability: bills, rules: billRules, alsoChanges: [...alsoChanges, restructure] });
    expect(problems).toEqual([]);
    expect(restructures).toEqual([restructure]);
    // One Bike can do (M27): a typed column turned into a link is checked and applied, not set aside.
    const link: DraftAlsoChange = { ...restructure, change: "Link each purchase to its supplier", edits: [{ kind: "link_column", sheet: "Purchases", column: null, step: null, after: null, role: null, person: null, link: { column: "What", to_capability: "Supplier bills", to_sheet: "Bills" } }] };
    const linked = check({ capability: bills, rules: billRules, alsoChanges: [...alsoChanges, link] });
    expect(linked.restructures).toEqual([]);
    const what = [...linked.edited.values()].flatMap((e) => e.after.sheets).find((s) => s.name === "Purchases")!.columns.filter((c) => c.name.startsWith("What"));
    expect(what.map((c) => [c.name, c.type])).toEqual([["What", "link"], ["What, as typed", "text"]]);
    // A rule that moves the purchase to a step Spend doesn't get is refused by the file check.
    const noBilled = alsoChanges.filter((c) => !c.change.includes("Billed"));
    expect(check({ capability: bills, rules: billRules, alsoChanges: noBilled }).problems).toContain(
      "Rule “When a bill is Paid, move its purchase to Billed.”: there is no step “Billed”.",
    );
  });
});
