import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditEntries, reports } from "@/db/schema";
import { kernelWorkspace } from "@/tests/kernel";
import { addMessage, startChat } from "../chats";
import { getReport, reportsIn, saveReport } from "./store";
import type { ReportResult } from "./schema";

// Report runs kept with their chat: report.ran in the Audit log with the chat; Run again adds a run; the
// author alone reads them.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
const result: ReportResult = { columns: [{ name: "Team", format: "text" }], rows: [["Engineering"]], sources: [{ capability: "Spend", sheet: "Purchases", name: "Purchases", read: 128, leftOut: 6 }] };
const query = { from: [], join: [], where: null, groupBy: [], measures: [], computed: [], orderBy: [], limit: null };

beforeAll(async () => {
  k = await kernelWorkspace();
});

describe("report runs", () => {
  it("are kept with their chat, logged as report.ran, and Run again adds one", async () => {
    const { chatId } = await k.as("ada", (tx, c) => startChat(tx, c, "report", { text: "Spend by team?" }));
    const messageId = await k.as("ada", (tx, c) => addMessage(tx, c, chatId, { from: "bike", text: "" }));
    const first = await k.as("ada", (tx, c) => saveReport(tx, c, { chatId, messageId, title: "Spend by team, Q4", query, chart: "bar", how: ["Spent: purchases."], missing: null, sentence: "Teams spent.", result }));
    await k.as("ada", (tx, c) => saveReport(tx, c, { chatId, messageId, firstId: first.id, title: "Spend by team, Q4", query, chart: "bar", how: [], missing: null, sentence: "Again.", result }));
    const runs = await k.as("ada", (tx, c) => reportsIn(tx, c, chatId));
    expect(runs.map((r) => r.firstId)).toEqual([null, first.id]);
    const ran = await k.as("ada", (tx) => tx.select().from(auditEntries).where(eq(auditEntries.event, "report.ran")));
    expect(ran[0]).toMatchObject({ chatId, details: { report: "“Spend by team, Q4”", rowsRead: 128 } });
    // Nobody else reads them: not through the kernel, not in the table.
    await expect(k.as("priya", (tx, c) => getReport(tx, c, first.id))).rejects.toThrow();
    expect(await k.as("priya", (tx) => tx.select().from(reports))).toEqual([]);
  });
});
