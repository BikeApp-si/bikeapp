import { addMessage, startChat, touchChat, updateMessage } from "@/server/kernel/chats";
import { atInstant } from "@/server/kernel/clock";
import { load, type KernelCtx } from "@/server/kernel/context";
import { runReport } from "@/server/kernel/report/run";
import type { ReportQuery } from "@/server/kernel/report/schema";
import { capabilitiesOf, saveReport, type Chart, type Series } from "@/server/kernel/report/store";
import type { Tx } from "@/server/kernel/tx";
import { BY_TEAM, CLOUD, STARTERS, STEP11 } from "./reports";

// Wade's report chats as 12a–12c show them: each asked on its day, its first run kept as of then. They are
// written as the report job writes them, with the screens' words for what the AI would have said, so seeding
// never calls the AI. Reopened today, Spend by team says its rows have changed since (12c).

type SeededReport = { at: Date; question: string; title: string; query: ReportQuery; chart: Chart; series: Series; how: string[]; missing: string | null; sentence: string };

export const REPORT_CHATS: SeededReport[] = [
  {
    at: new Date("2026-10-20T16:15:00Z"), // Oct 20, 11:15
    question: STEP11.cloud,
    title: "Cloud spend since July",
    query: CLOUD,
    chart: "bar",
    series: [{ column: "Cloud", role: "measure" }],
    how: ["Cloud: expenses in Spend in the Cloud category, added up by month. 16 expenses."],
    missing: "Spend only has expenses from Jul 1, 2026, when it was created, so 2025 can't be answered.",
    sentence: "Spend only has expenses from Jul 1, 2026, when it was created, so I can’t answer for 2025. From Jul 1 to today, cloud cost **$18,400**.",
  },
  {
    at: new Date("2026-10-26T14:48:00Z"), // Oct 26, 09:48
    question: STEP11.starters,
    title: "November starters",
    query: STARTERS,
    chart: "none",
    series: [],
    how: ["From Hiring (offers accepted), Onboarding (tasks) and Spend (laptop purchases), joined by person. 3 people."],
    missing: null,
    sentence: "3 people start in November. **Leo Grant** has no onboarding tasks and no laptop request yet.",
  },
  {
    at: new Date("2026-10-26T15:02:00Z"), // Oct 26, 10:02 (REPORT_ASKED)
    question: STEP11.byTeam,
    title: "Spend by team, Q4",
    query: BY_TEAM,
    chart: "bar",
    series: [{ column: "Budget", role: "comparison" }, { column: "Spent", role: "measure" }],
    how: [
      "Spent: purchases in Spend at Approved, Ordered or Received, dated Oct 1–26, 2026, added up by team. 128 purchases; 6 rejected ones are left out.",
      "Budget: each team’s Q4 budget in Tools and budgets.",
      "Left: budget minus spent.",
    ],
    missing: null,
    sentence: "This quarter so far (Oct 1–26), teams have spent **$95,300 of $140,000**. Marketing has used 87% of its budget and Engineering 82%, with two months to go.",
  },
];

export async function seedReportChats(tx: Tx, wade: KernelCtx) {
  const loaded = await load(tx);
  for (const r of REPORT_CHATS) {
    await atInstant(r.at, async () => {
      const ctx = { ...wade, now: r.at };
      const { chatId } = await startChat(tx, ctx, "report", { text: r.question });
      const replyId = await addMessage(tx, ctx, chatId, { from: "bike", text: r.sentence });
      const result = await runReport(tx, ctx, r.query, { asOf: r.at });
      const saved = await saveReport(tx, ctx, { chatId, messageId: replyId, title: r.title, query: r.query, chart: r.chart, series: r.series, how: r.how, missing: r.missing, sentence: r.sentence, result, ranAt: r.at });
      await updateMessage(tx, ctx, replyId, { parts: [{ kind: "report", reportId: saved.id }] });
      // In the report's own order (12a: "Hiring, Onboarding, Spend").
      const ids = capabilitiesOf(result).flatMap((n) => [...loaded.files.values()].filter((f) => f.file.name === n).map((f) => f.id));
      await touchChat(tx, ctx, chatId, { title: r.title, capabilityIds: ids });
    });
  }
}
