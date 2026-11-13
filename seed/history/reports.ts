import type { ReportQuery } from "@/server/kernel/report/schema";

// The questions typed on screens 11a–11g and 12d, and queries that answer them as the screens do. The seeded
// report chats (12a–12c) run them, and so do the history tests, the recordings and the replays.
export const STEP11 = {
  byTeam: "Show spend by team this quarter against each team’s budget.",
  engineering: "Show Engineering month by month since July.",
  starters: "Who starts in November, and are their onboarding and laptop ready?",
  cloud: "How much did we spend on cloud in 2025?",
};

const base = { join: [], groupBy: [], measures: [], computed: [], orderBy: [], limit: null, where: null } satisfies Partial<ReportQuery>;
const counted = { op: "in" as const, args: [{ col: "Purchases.Status" }, "Approved", "Ordered", "Received"] };

// 11c: Q4 so far by team, against each team's Q4 budget.
export const BY_TEAM: ReportQuery = {
  ...base,
  from: [{ capability: "Spend", sheet: "Purchases", as: null }, { capability: "Tools and budgets", sheet: "Budgets", as: null }],
  join: [{ source: "Budgets", on: { equal: ["Budgets.Team", "Purchases.Team"] } }],
  where: { op: "and", args: [counted, { op: "between", args: [{ col: "Purchases.Date" }, "2026-10-01", { ref: "today" }] }, { op: "eq", args: [{ col: "Budgets.Quarter" }, "Q4"] }] },
  groupBy: [{ column: "Purchases.Team" }],
  measures: [
    { fn: "sum", source: "Budgets", column: "Budgets.Budget", where: null, as: "Budget", hidden: false },
    { fn: "sum", source: "Purchases", column: "Purchases.Total", where: null, as: "Spent", hidden: false },
  ],
  computed: [
    { as: "Left", expr: { op: "sub", args: [{ col: "Budget" }, { col: "Spent" }] }, template: null, empty: null, format: "money" },
    { as: "Used", expr: { op: "mul", args: [{ op: "div", args: [{ col: "Spent" }, { col: "Budget" }] }, 100] }, template: null, empty: null, format: "percent" },
  ],
  orderBy: [{ column: "Spent", dir: "desc" }],
};

// 11e: Engineering by month since July, against a third of each quarter's budget.
export const ENGINEERING: ReportQuery = {
  ...base,
  from: [{ capability: "Spend", sheet: "Purchases", as: null }, { capability: "Tools and budgets", sheet: "Budgets", as: null }],
  join: [{ source: "Budgets", on: { equal: ["Budgets.Team", "Purchases.Team"] } }],
  where: { op: "and", args: [counted, { op: "eq", args: [{ col: "Purchases.Team" }, "Engineering"] }, { op: "between", args: [{ col: "Purchases.Date" }, "2026-07-01", { ref: "today" }] }, { op: "eq", args: [{ col: "Budgets.Quarter" }, "Q4"] }] },
  groupBy: [{ month: "Purchases.Date" }],
  measures: [
    { fn: "sum", source: "Purchases", column: "Purchases.Total", where: null, as: "Spent", hidden: false },
    { fn: "sum", source: "Budgets", column: "Budgets.Budget", where: null, as: "Quarter budget", hidden: true },
  ],
  computed: [{ as: "Budget", expr: { op: "div", args: [{ col: "Quarter budget" }, 3] }, template: null, empty: null, format: "money" }],
};

// 11f: November starters, their first week and their laptop.
export const STARTERS: ReportQuery = {
  ...base,
  from: [
    { capability: "Hiring", sheet: "Candidates", as: null },
    { capability: "Onboarding", sheet: "Plans", as: null },
    { capability: "Onboarding", sheet: "Tasks", as: null },
    { capability: "Spend", sheet: "Purchases", as: null },
  ],
  join: [
    { source: "Plans", on: { equal: ["Plans.Name", "Candidates.Name"] } },
    { source: "Tasks", on: { link: "Tasks.Plan" } },
    { source: "Purchases", on: { names: ["Purchases.What", "Candidates.Name"] } },
  ],
  where: { op: "between", args: [{ col: "Candidates.Start date" }, "2026-11-01", "2026-11-30"] },
  groupBy: [{ column: "Candidates.Name" }, { column: "Candidates.Opening" }, { column: "Candidates.Start date" }],
  measures: [
    { fn: "count", source: "Tasks", column: null, where: null, as: "Tasks", hidden: true },
    { fn: "count", source: "Tasks", column: null, where: { op: "eq", args: [{ col: "Tasks.Status" }, "Done"] }, as: "Done", hidden: true },
    { fn: "first", source: "Purchases", column: "Purchases.Status", where: null, as: "Laptop status", hidden: true },
  ],
  computed: [
    { as: "Onboarding", expr: null, template: "{Done} of {Tasks} tasks done", empty: "Not started", format: "text" },
    { as: "Laptop", expr: null, template: "{Laptop status}", empty: "No request", format: "text" },
  ],
  orderBy: [{ column: "Start date", dir: "asc" }],
};

// 11g: cloud expenses by month (Spend has them only from Jul 1, 2026).
export const CLOUD: ReportQuery = {
  ...base,
  from: [{ capability: "Spend", sheet: "Expenses", as: null }],
  where: { op: "and", args: [{ op: "eq", args: [{ col: "Expenses.Category" }, "Cloud"] }, { op: "between", args: [{ col: "Expenses.Date" }, "2025-01-01", { ref: "today" }] }] },
  groupBy: [{ month: "Expenses.Date" }],
  measures: [{ fn: "sum", source: "Expenses", column: "Expenses.Amount", where: null, as: "Cloud", hidden: false }],
};
