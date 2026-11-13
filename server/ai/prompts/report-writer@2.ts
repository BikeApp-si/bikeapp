import { z } from "zod";
import { draftQuery } from "@/server/kernel/report/draft";
import { type Prompt } from "../prompt";
import { companyWays, PLAIN_WORDS } from "./shared";
import type { Formats } from "@/lib/format";

// Prompt 7, the report writer (developer notes §8, large model). An admin's question on Home → a query in
// the kernel's own schema (never SQL), the chart, how it was worked out, and what the data can't answer.
// It sees the capabilities' structure and counts, never rows; the kernel checks every name and runs it.

export type ReportWriterInput = {
  company: { name: string; timeZone: string };
  today: string; // YYYY-MM-DD
  user: string;
  capabilities: Record<string, unknown>[]; // structure.ts, the ones the admin can see
  facts: { capability: string; sheet: string; rows: number; dates: Record<string, [string, string]> }[];
  people: string[];
  conversation: { from: "person" | "bike"; text: string }[];
  currentReport: { title: string; query: unknown; chart: unknown } | null; // the one the latest message changes
  latestMessage: string;
  formats?: Formats; // the company's currency and financial year (M26); said only when they aren't the defaults
};

export const reportOutput = z.object({
  title: z.string().min(1).max(60), // "Spend by team, Q4"
  query: draftQuery,
  chart: z.object({
    kind: z.enum(["bar", "line", "none"]), // bar to compare, line over time, none for a list
    // Which columns it draws: the measure in the strong colour, a comparison (a budget) in the light one, a
    // target as a dashed line across.
    series: z.array(z.object({ column: z.string(), role: z.enum(["measure", "comparison", "target"]) })),
  }),
  how: z.array(z.string()).min(1).max(4), // "Spent: purchases in Spend at Approved, Ordered or Received, dated Oct 1–26, 2026, added up by team."
  missing: z.string().nullable(), // "Spend only has expenses from Jul 1, 2026, so I can't answer for 2025."
});
export type ReportOutput = z.infer<typeof reportOutput>;

const EXAMPLE = {
  title: "Spend by team, Q4",
  query: {
    from: [
      { capability: "Spend", sheet: "Purchases" },
      { capability: "Tools and budgets", sheet: "Budgets" },
    ],
    join: [{ source: "Budgets", kind: "equal", left: "Budgets.Team", right: "Purchases.Team" }],
    where: JSON.stringify({ op: "and", args: [{ op: "in", args: [{ col: "Purchases.Status" }, "Approved", "Ordered", "Received"] }, { op: "between", args: [{ col: "Purchases.Date" }, "2026-10-01", { ref: "today" }] }, { op: "eq", args: [{ col: "Budgets.Quarter" }, "Q4"] }] }),
    group_by: [{ column: "Purchases.Team", by: "value" }],
    measures: [
      { fn: "sum", source: "Budgets", column: "Budgets.Budget", where: null, as: "Budget", hidden: false },
      { fn: "sum", source: "Purchases", column: "Purchases.Total", where: null, as: "Spent", hidden: false },
    ],
    computed: [
      { as: "Left", expr: JSON.stringify({ op: "sub", args: [{ col: "Budget" }, { col: "Spent" }] }), template: null, empty: null, format: "money" },
      { as: "Used", expr: JSON.stringify({ op: "mul", args: [{ op: "div", args: [{ col: "Spent" }, { col: "Budget" }] }, 100] }), template: null, empty: null, format: "percent" },
    ],
    order_by: [{ column: "Spent", dir: "desc" }],
    limit: null,
  },
  chart: { kind: "bar", series: [{ column: "Budget", role: "comparison" }, { column: "Spent", role: "measure" }] },
  how: ["Spent: purchases in Spend at Approved, Ordered or Received, dated Oct 1–26, 2026, added up by team.", "Budget: each team's Q4 budget in Tools and budgets.", "Left: budget minus spent."],
  missing: null,
};

const SYSTEM = `You write reports for Bike, an ERP small companies run in. An admin asks a question about their data; you answer with a query in Bike's own query schema, which the kernel checks and runs with the admin's access. You never see rows and never compute a number: the kernel does. You only write the query, the chart, how it was worked out, and what the data can't answer.

The query:
- from: the sheets it reads, by exact capability and sheet names. The first is the one you group or list; the others are joined to it.
- join: one for each sheet after the first, connecting it to a sheet before it. kind "equal": left (a column of the joined sheet) has the same value as right (a column of an earlier sheet), such as a team or a person. kind "link": left is a link column on either side that points at the other sheet's rows (right null). kind "names": left is a text column of the joined sheet that names right's value ("Laptop for Mei Chen" names "Mei Chen").
- where: one JSON expression, an "and" of conditions, each about one sheet only. Columns as {"col":"Sheet.Column"}; ops eq, ne, gt, gte, lt, lte, in (value, then the choices), between (value, from, to), empty, not, and, or. Money in dollars, dates as "2026-10-01", steps and choices by name, people by full name, and {"ref":"today"} for today. "So far" ends at {"ref":"today"}, so running it again later counts what came in since. A condition on a joined sheet keeps only its rows.
- group_by: columns of the first sheet, by value, or by month for a date column.
- measures: count, sum, avg, min, max or first of a column of one source, added up per group through the joins; count with no column counts rows; where (JSON, about that source) counts only some rows ("tasks that are Done"); hidden for one only a computed column uses.
- computed: a value from the measures by name ({"col":"Spent"}) as a JSON expression (add, sub, mul, div, if); a percent is the ratio times 100 with format "percent"; or words with measures in braces as a template ("{Done} of {Tasks} tasks done") and what to say when they're all empty ("Not started").
- order_by: output column names; limit, or null.

The chart: bar to compare groups, line over time, none for a list. series names output columns: measure (the main number), comparison (a budget beside it), target (a dashed line across, such as a monthly budget).
how: one plain line per column that needs it, saying where it comes from and which rows count, with real dates ("dated Oct 1–26, 2026").
missing: only when the question asks for something the data can't give: a period before a sheet's dates start, or something no sheet records. Say plainly what there is ("Spend only has expenses from Jul 1, 2026"). Then answer for what exists: when the period asked starts before the sheet's first date, the query covers from that first date to today instead, by month, never an empty period. Otherwise null: never a note about what the report leaves out on purpose. Before saying something isn't recorded, look for the sheet whose rows would hold it: a laptop for a person is a purchase whose item names them.
title: a few words ("Spend by team, Q4").
When the admin changes a report, apply their latest message to the current report and keep the rest.
Use only the capabilities, sheets and columns given; never invent one. ${PLAIN_WORDS}

An example. For "Show spend by team this quarter against each team's budget." on Oct 26, 2026, the answer was:
${JSON.stringify(EXAMPLE)}
It shows the shape; never copy it for another question.

Answer with the JSON object only.`;

export const reportWriter: Prompt<ReportWriterInput, ReportOutput> = {
  name: "report-writer",
  version: 2,
  model: "large",
  effort: "medium",
  maxTokens: 8000,
  structured: false,
  system: SYSTEM,
  schema: reportOutput,
  render(i) {
    const context = JSON.stringify({ company: i.company, capabilities: i.capabilities, people: i.people });
    const message = [
      `Today is ${i.today}. Rows and dates in each sheet:\n${JSON.stringify(i.facts)}`,
      companyWays(i.formats, ["money", "year", "write"]),
      i.conversation.length ? `Conversation so far:\n${i.conversation.map((m) => `${m.from === "person" ? i.user : "Bike"}: ${m.text}`).join("\n")}` : "",
      i.currentReport ? `The current report:\n${JSON.stringify(i.currentReport)}` : "",
      `Latest message from ${i.user}:\n${i.latestMessage}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    return { context, message };
  },
};
