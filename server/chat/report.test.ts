import { runQueued } from "@/server/jobs/run";
import "@/server/jobs/runners";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditEntries, chats, people } from "@/db/schema";
import { NoModel, useProvider } from "@/server/ai/gateway";
import type { ProviderRequest } from "@/server/ai/providers/types";
import { seedWorkspace } from "@/seed";
import { seedCapabilities } from "@/seed/capabilities";
import { FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES } from "@/seed/fernwood";
import { REPORT_ASKED, seedHistory } from "@/seed/history";
import { readChat } from "@/server/kernel/chats";
import { atInstant } from "@/server/kernel/clock";
import type { KernelCtx } from "@/server/kernel/context";
import { toDraft } from "@/server/kernel/report/draft";
import { reportsIn } from "@/server/kernel/report/store";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { BY_TEAM, STEP11 } from "@/seed/history/reports";
import { chatView } from "./view";
import { RAN_AGAIN } from "./report";
import { runAgain, send } from "./send";

// A report from chat (11a–11e, 12d) with a stand-in for prompts 2 and 7: the kernel checks the query and runs
// it, the numbers are the seed's, the run is kept with the chat, Run again sets two runs side by side, and a
// reply changes the report. Only admins ask.

let ws: string;
const ids = new Map<string, string>();
const as = <T>(n: string, fn: (tx: Tx, c: KernelCtx) => Promise<T>) =>
  withWorkspace({ workspaceId: ws, personId: ids.get(n) }, (tx) => fn(tx, { workspaceId: ws, actor: { id: ids.get(n)!, email: `${n}@fernwood.dev` } }));
const sent: ProviderRequest[] = [];
let noModel = false; // O3: the open Bike with no key
let sentence = "This quarter so far (Oct 1–26), teams have spent **$95,300 of $140,000**. Marketing has used 87% of its budget.";
const DESIGN = { type: "report", lead: "I'll put that report together.", brief: null, left_out: null, question: null, capability: null, rule_requests: [], rules_from: null, suggested_connections: [], also_changes: [], experience: null, flags: [] };
const REPORT = {
  title: "Spend by team, Q4",
  query: toDraft(BY_TEAM),
  chart: { kind: "bar", series: [{ column: "Budget", role: "comparison" }, { column: "Spent", role: "measure" }] },
  how: ["Spent: purchases in Spend at Approved, Ordered or Received, dated from Oct 1, 2026, added up by team.", "Budget: each team's Q4 budget in Tools and budgets."],
  missing: null,
};

beforeAll(async () => {
  ws = (await seedWorkspace({ subdomain: `rp${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
  await seedCapabilities(ws);
  await seedHistory(ws);
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    for (const p of await tx.select({ id: people.id, email: people.email }).from(people)) ids.set(p.email.split("@")[0]!, p.id);
  });
  useProvider({
    call: async (req) => {
      sent.push(req);
      if (noModel) throw new NoModel();
      const answer = req.prompt.startsWith("capability-designer") ? DESIGN : req.prompt === "report-writer@3" ? REPORT : { sentence };
      return { model: "claude-opus-5-5", text: JSON.stringify(answer), stop: "done", usage: { tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 }, ms: 1 };
    },
  });
}, 120_000);
afterAll(() => useProvider(null));

const last = async (chatId: string) => (await as("wade", (tx, c) => readChat(tx, c, chatId))).messages.at(-1)!;
let chatId: string;

describe("a report from chat", () => {
  it("11a–11c: the question becomes a report chat; the kernel's numbers, as of Oct 26 10:02", async () => {
    await atInstant(REPORT_ASKED, async () => {
      chatId = (await as("wade", (tx, c) => send(tx, c, null, STEP11.byTeam, []))).chatId;
      await runQueued(ws);
    });
    const reply = await last(chatId);
    expect(reply.status).toBe("done");
    expect(reply.text).toBe(sentence);
    const [chat] = await as("wade", (tx) => tx.select().from(chats).where(eq(chats.id, chatId)));
    expect([chat!.kind, chat!.title]).toEqual(["report", "Spend by team, Q4"]);
    const view = await as("wade", (tx, c) => chatView(tx, c, chatId));
    const report = Object.values(view.reports)[0]!;
    // In chat Used rides with Left (11c); the PDF keeps both with a total (11h), the CSV plain numbers (11i).
    expect(report.table.columns).toEqual(["Team", "Budget", "Spent", "Left"]);
    expect(report.table.rows[0]).toEqual(["Engineering", "$60,000", "$49,200", "$10,800 (82% used)"]);
    expect(report.print.total).toEqual(["Total", "$140,000", "$95,300", "$44,700", "68%"]);
    expect(report.csv.rows.at(-1)).toEqual(["Total", 140000, 95300, 44700, "68%"]);
    expect(report.period).toBe("Oct 1–26, 2026");
    expect(report.card).toBe("Report · Spend, Tools and budgets · 128 purchases");
    expect(report.how[0]).toMatch(/128 purchases\.$/);
    expect(report.chart.series.map((s) => [s.name, s.role])).toEqual([["Budget", "comparison"], ["Spent", "measure"]]);
    // The sentence prompt saw only the result table, never rows.
    expect(sent.find((r) => r.prompt === "report-sentence@1")!.message).toContain('"rows_read":"128 purchases"');
    const ran = await as("wade", (tx) => tx.select().from(auditEntries).where(and(eq(auditEntries.event, "report.ran"), eq(auditEntries.chatId, chatId))));
    expect(ran).toHaveLength(1);
  });

  it("12c–12d: reopened later its rows have changed; Run again sets the two runs side by side", async () => {
    const first = (await as("wade", (tx, c) => reportsIn(tx, c, chatId)))[0]!;
    expect((await as("wade", (tx, c) => chatView(tx, c, chatId))).changed[first.id]).toBe(true);
    sentence = "Ran again with data to Oct 27: teams have spent **$101,900 of $140,000**, $6,600 more than on Oct 26. Marketing is now at 93%.";
    await as("wade", (tx, c) => runAgain(tx, c, chatId, first.id));
    await runQueued(ws);
    const view = await as("wade", (tx, c) => chatView(tx, c, chatId));
    const second = Object.values(view.reports).find((r) => r.firstId === first.id)!;
    expect(second.table.columns).toEqual(["Team", "Budget", "Oct 26", "Oct 27"]);
    expect(second.table.rows[1]).toEqual(["Marketing", "$25,000", "$21,800", "$23,300"]);
    expect(second.card).toMatch(/^Report · Oct 27, \d\d:\d\d · 139 purchases$/);
    expect(view.messages.find((m) => m.parts.some((p) => p.kind === "report" && p.reportId === first.id))!.parts.at(-1)).toMatchObject({ kind: "collapsed" });
  });

  it("with no model, Run again gives today's numbers without the sentence", async () => {
    const first = (await as("wade", (tx, c) => reportsIn(tx, c, chatId)))[0]!;
    noModel = true;
    try {
      await as("wade", (tx, c) => runAgain(tx, c, chatId, first.id));
      await runQueued(ws);
    } finally {
      noModel = false;
    }
    const reply = await last(chatId);
    expect(reply).toMatchObject({ text: RAN_AGAIN, status: "done" });
    expect(reply.parts).toEqual([expect.objectContaining({ kind: "report" })]);
  });

  it("refuses a sentence with a number the table doesn't give, once, then the reply says it couldn't", async () => {
    sentence = "Teams spent $99,999.";
    await as("wade", (tx, c) => send(tx, c, chatId, "Same, but only Engineering.", []));
    await runQueued(ws);
    expect(sent.at(-1)!.retry?.problems.join(" ")).toContain("99,999 isn't in the table");
    expect((await last(chatId)).status).toBe("failed");
    // The reply in a report chat went straight to prompt 7, with the report it changes.
    expect(sent.filter((r) => r.prompt === "report-writer@3").at(-1)!.message).toContain("The current report:");
  });

  it("only admins ask: Maya can't start a chat", async () => {
    await expect(as("maya", (tx, c) => send(tx, c, null, STEP11.byTeam, []))).rejects.toThrow();
  });
});
