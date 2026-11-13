import { beforeAll, describe, expect, it } from "vitest";
import { kernelWorkspace } from "@/tests/kernel";
import { createRow } from "../rows";
import type { CapabilityFile } from "../schema/file";
import { runReport } from "./run";
import type { ReportQuery } from "./schema";

// The report runner (11a–11g): sources read with the asking admin's access and as of a time, each filtered
// by its own conditions, the first grouped, the others added up through their joins, the same every run.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
const AT = new Date("2026-10-26T15:00:00Z");
const LATER = new Date("2026-10-27T15:00:00Z");
const TEAMS = [{ id: "eng", name: "Engineering" }, { id: "sales", name: "Sales" }];

const spend = (): CapabilityFile => ({
  name: "Spend",
  icon: "wallet",
  sheets: [
    {
      id: "purchases",
      name: "Purchases",
      kind: "list",
      titleColumn: "what",
      columns: [
        { id: "what", name: "What", type: "text", required: true },
        { id: "team", name: "Team", type: "choice", options: TEAMS },
        { id: "date", name: "Date", type: "date" },
        { id: "amount", name: "Amount", type: "money" },
        { id: "status", name: "Status", type: "step" },
      ],
      steps: [
        { id: "submitted", name: "Submitted", start: true },
        { id: "approved", name: "Approved", end: "final" },
        { id: "rejected", name: "Rejected", end: "exit" },
      ],
    },
  ],
  roles: [{ id: "admins", name: "Admins", members: { kind: "people", people: [k.id.ada] }, can: ["see", "add", "edit", "move_steps"], scope: "all" }],
  rules: [],
  later: [],
});

const budgets = (): CapabilityFile => ({
  name: "Tools and budgets",
  icon: "wrench",
  sheets: [
    {
      id: "budgets",
      name: "Budgets",
      kind: "list",
      titleColumn: "quarter",
      columns: [
        { id: "team", name: "Team", type: "choice", options: TEAMS },
        { id: "quarter", name: "Quarter", type: "text", required: true },
        { id: "budget", name: "Budget", type: "money" },
      ],
    },
  ],
  roles: [{ id: "admins", name: "Admins", members: { kind: "people", people: [k.id.ada] }, can: ["see", "add", "edit"], scope: "all" }],
  rules: [],
  later: [],
});

const hiring = (): CapabilityFile => ({
  name: "Hiring",
  icon: "briefcase",
  sheets: [
    {
      id: "candidates",
      name: "Candidates",
      kind: "list",
      titleColumn: "name",
      columns: [
        { id: "name", name: "Name", type: "text", required: true },
        { id: "start", name: "Start date", type: "date" },
      ],
    },
    {
      id: "plans",
      name: "Plans",
      kind: "list",
      titleColumn: "starter",
      columns: [{ id: "starter", name: "Starter", type: "text", required: true }],
    },
    {
      id: "tasks",
      name: "Tasks",
      kind: "list",
      titleColumn: "task",
      columns: [
        { id: "task", name: "Task", type: "text", required: true },
        { id: "plan", name: "Plan", type: "link", link: { sheet: "plans" } },
        { id: "done", name: "Done", type: "choice", options: [{ id: "yes", name: "Yes" }, { id: "no", name: "No" }] },
      ],
    },
  ],
  roles: [{ id: "admins", name: "Admins", members: { kind: "people", people: [k.id.ada] }, can: ["see", "add", "edit"], scope: "all" }],
  rules: [],
  later: [],
});

let ids: { spend: string; budgets: string; hiring: string };
const add = (cap: string, sheet: string, values: Record<string, unknown>, at = AT) => k.as("ada", (tx, c) => createRow(tx, c, cap, sheet, { values }), at).then((r) => r.id);
const purchase = (what: string, team: string, date: string, dollars: number, status = "approved", at = AT) =>
  add(ids.spend, "purchases", { what, team, date, amount: dollars * 100 }, at).then(async (id) => {
    if (status !== "submitted") {
      const { moveStep } = await import("../rows");
      await k.as("ada", (tx, c) => moveStep(tx, c, id, status), at);
    }
    return id;
  });

const q = (over: Partial<ReportQuery>): ReportQuery => ({ from: [], join: [], where: null, groupBy: [], measures: [], computed: [], orderBy: [], limit: null, ...over });
const sum = (source: string, column: string, as: string) => ({ fn: "sum" as const, source, column, where: null, as, hidden: false });
const run = (query: ReportQuery, asOf = AT, who: "ada" | "maya" = "ada") => k.as(who, (tx, c) => runReport(tx, c, query, { asOf }), asOf);

beforeAll(async () => {
  k = await kernelWorkspace();
  ids = { spend: await k.create(spend()), budgets: await k.create(budgets()), hiring: await k.create(hiring()) };
  await purchase("Laptops", "eng", "2026-07-10", 3000);
  await purchase("Servers", "eng", "2026-08-02", 2000);
  await purchase("Licenses", "eng", "2026-10-05", 5000);
  await purchase("CRM seats", "sales", "2026-10-07", 1500);
  await purchase("Booth", "sales", "2026-10-09", 900, "rejected");
  await add(ids.budgets, "budgets", { team: "eng", quarter: "Q4", budget: 6_000_00 });
  await add(ids.budgets, "budgets", { team: "sales", quarter: "Q4", budget: 3_000_00 });
  await add(ids.budgets, "budgets", { team: "eng", quarter: "Q3", budget: 5_000_00 });
  for (const [name, start] of [["Ana Ruiz", "2026-11-02"], ["Leo Grant", "2026-11-10"], ["Tom Hale", "2026-12-01"]] as const) await add(ids.hiring, "candidates", { name, start });
  const ana = await add(ids.hiring, "plans", { starter: "Ana Ruiz" });
  for (const done of ["yes", "yes", "no"]) await add(ids.hiring, "tasks", { task: "Task", plan: ana, done });
  await purchase("Laptop for Ana Ruiz", "eng", "2026-10-20", 2400, "submitted");
  // Written after AT: counted as of later, not as of AT.
  await purchase("Monitors", "eng", "2026-10-26", 700, "approved", LATER);
});

describe("running a report", () => {
  const spentVsBudget = q({
    from: [{ capability: "Spend", sheet: "Purchases", as: null }, { capability: "Tools and budgets", sheet: "Budgets", as: null }],
    join: [{ source: "Budgets", on: { equal: ["Budgets.Team", "Purchases.Team"] } }],
    where: { op: "and", args: [{ op: "in", args: [{ col: "Purchases.Status" }, "Approved"] }, { op: "between", args: [{ col: "Purchases.Date" }, "2026-10-01", { ref: "today" }] }, { op: "eq", args: [{ col: "Budgets.Quarter" }, "Q4"] }] },
    groupBy: [{ column: "Purchases.Team" }],
    measures: [sum("Budgets", "Budgets.Budget", "Budget"), sum("Purchases", "Purchases.Amount", "Spent")],
    computed: [
      { as: "Left", expr: { op: "sub", args: [{ col: "Budget" }, { col: "Spent" }] }, template: null, empty: null, format: "money" },
      { as: "Used", expr: { op: "mul", args: [{ op: "div", args: [{ col: "Spent" }, { col: "Budget" }] }, 100] }, template: null, empty: null, format: "percent" },
    ],
    orderBy: [{ column: "Spent", dir: "desc" }],
  });

  it("adds up each source once per group: a team's budget isn't counted once per purchase", async () => {
    const r = await run(spentVsBudget);
    expect(r.columns.map((c) => [c.name, c.format])).toEqual([["Team", "text"], ["Budget", "money"], ["Spent", "money"], ["Left", "money"], ["Used", "percent"]]);
    expect(r.rows).toEqual([
      ["Engineering", 6000, 5000, 1000, 83],
      ["Sales", 3000, 1500, 1500, 50],
    ]);
    const purchases = r.sources.find((s) => s.sheet === "Purchases")!;
    expect([purchases.read, purchases.leftOut]).toEqual([2, 4]);
  });

  it("counts rows as of a time, and today as of then", async () => {
    expect((await run(spentVsBudget, LATER)).rows[0]).toEqual(["Engineering", 6000, 5700, 300, 95]);
  });

  it("groups by month, in order", async () => {
    const r = await run(
      q({
        from: [{ capability: "Spend", sheet: "Purchases", as: null }],
        where: { op: "and", args: [{ op: "eq", args: [{ col: "Purchases.Team" }, "Engineering"] }, { op: "eq", args: [{ col: "Purchases.Status" }, "Approved"] }] },
        groupBy: [{ month: "Purchases.Date" }],
        measures: [sum("Purchases", "Purchases.Amount", "Spent"), { fn: "count", source: "Purchases", column: null, where: null, as: "Purchases", hidden: false }],
      }),
    );
    expect(r.columns[0]).toEqual({ name: "Month", format: "month" });
    expect(r.rows).toEqual([["2026-07", 3000, 1], ["2026-08", 2000, 1], ["2026-10", 5000, 1]]);
  });

  it("joins a list across a link and by names, with words for what's empty", async () => {
    const r = await run(
      q({
        from: [{ capability: "Hiring", sheet: "Candidates", as: null }, { capability: "Hiring", sheet: "Plans", as: null }, { capability: "Hiring", sheet: "Tasks", as: null }, { capability: "Spend", sheet: "Purchases", as: null }],
        join: [
          { source: "Plans", on: { equal: ["Plans.Starter", "Candidates.Name"] } },
          { source: "Tasks", on: { link: "Tasks.Plan" } },
          { source: "Purchases", on: { names: ["Purchases.What", "Candidates.Name"] } },
        ],
        where: { op: "between", args: [{ col: "Candidates.Start date" }, "2026-11-01", "2026-11-30"] },
        groupBy: [{ column: "Candidates.Name" }, { column: "Candidates.Start date" }],
        measures: [
          { fn: "count", source: "Tasks", column: null, where: null, as: "Tasks", hidden: true },
          { fn: "count", source: "Tasks", column: null, where: { op: "eq", args: [{ col: "Tasks.Done" }, "Yes"] }, as: "Done", hidden: true },
          { fn: "first", source: "Purchases", column: "Purchases.Status", where: null, as: "Laptop status", hidden: true },
        ],
        computed: [
          { as: "Onboarding", expr: null, template: "{Done} of {Tasks} tasks done", empty: "Not started", format: "text" },
          { as: "Laptop", expr: null, template: "{Laptop status}", empty: "No request", format: "text" },
        ],
      }),
    );
    expect(r.rows).toEqual([
      ["Ana Ruiz", "2026-11-02", "2 of 3 tasks done", "Submitted"],
      ["Leo Grant", "2026-11-10", "Not started", "No request"],
    ]);
  });
});

describe("refusals", () => {
  it("only admins get reports", async () => {
    await expect(run(q({ from: [{ capability: "Spend", sheet: "Purchases", as: null }], measures: [sum("Purchases", "Purchases.Amount", "Spent")] }), AT, "maya")).rejects.toThrow();
  });

  it("names that don't exist are refused, with what's wrong", async () => {
    await expect(run(q({ from: [{ capability: "Payroll", sheet: "Runs", as: null }], measures: [] }))).rejects.toThrow("no app “Payroll”");
    await expect(run(q({ from: [{ capability: "Spend", sheet: "Purchases", as: null }], measures: [sum("Purchases", "Purchases.Cost", "Spent")] }))).rejects.toThrow("Purchases has no column “Cost”");
    await expect(
      run(q({ from: [{ capability: "Spend", sheet: "Purchases", as: null }, { capability: "Tools and budgets", sheet: "Budgets", as: null }], where: { op: "eq", args: [{ col: "Purchases.Team" }, { col: "Budgets.Team" }] }, measures: [sum("Purchases", "Purchases.Amount", "Spent")], join: [{ source: "Budgets", on: { equal: ["Budgets.Team", "Purchases.Team"] } }] })),
    ).rejects.toThrow("Each condition must be about one source");
  });
});
