import { asc, eq } from "drizzle-orm";
import { chats, reports } from "@/db/schema";
import { mustBeAdmin } from "../admin";
import { record } from "../audit";
import { currentTime } from "../clock";
import { AccessError, load, type KernelCtx } from "../context";
import type { Tx } from "../tx";
import type { ReportQuery, ReportResult } from "./schema";

// Report runs, kept with the chat they were asked in (11c–12d): the query, the result, when and as whom.
// Each run is an Audit entry (report.ran, with the chat, so 12f links to it); each download is another.

export type Chart = "bar" | "line" | "none";
export type Series = { column: string; role: "measure" | "comparison" | "target" }[];
export type StoredReport = {
  id: string;
  chatId: string;
  messageId: string;
  firstId: string | null;
  title: string;
  query: ReportQuery;
  chart: Chart;
  series: Series;
  how: string[];
  missing: string | null;
  sentence: string;
  result: ReportResult;
  ranAt: Date;
  ranAs: string;
};

const asStored = (r: typeof reports.$inferSelect): StoredReport => ({ ...r, query: r.query as ReportQuery, chart: r.chart as Chart, series: r.series as Series, how: r.how as string[], result: r.result as ReportResult });

// Capabilities a run read, by name, for the Audit entry and the card ("Spend, Tools and budgets").
export const capabilitiesOf = (result: ReportResult) => [...new Set(result.sources.map((s) => s.capability))];

export async function saveReport(
  tx: Tx,
  ctx: KernelCtx,
  r: { chatId: string; messageId: string; firstId?: string | null; title: string; query: ReportQuery; chart: Chart; series?: Series; how: string[]; missing: string | null; sentence: string; result: ReportResult; ranAt?: Date },
): Promise<StoredReport> {
  await mustBeAdmin(tx, ctx);
  const ranAt = r.ranAt ?? ctx.now ?? currentTime();
  const [row] = await tx
    .insert(reports)
    .values({ workspaceId: ctx.workspaceId, chatId: r.chatId, messageId: r.messageId, firstId: r.firstId ?? null, title: r.title, query: r.query, chart: r.chart, series: r.series ?? [], how: r.how, missing: r.missing, sentence: r.sentence, result: r.result, ranAt, ranAs: ctx.actor.id })
    .returning();
  const loaded = await load(tx);
  const names = capabilitiesOf(r.result);
  const firstCap = [...loaded.files.values()].find((f) => f.file.name === names[0])?.id;
  const read = r.result.sources[0]?.read ?? 0;
  await record(tx, ctx, { who: ctx.actor.email, capabilityId: firstCap, event: "report.ran", details: { report: `“${r.title}”`, rowsRead: read }, chatId: r.chatId, at: ranAt });
  return asStored(row!);
}

export async function getReport(tx: Tx, ctx: KernelCtx, id: string): Promise<StoredReport> {
  await mustBeAdmin(tx, ctx);
  const [r] = await tx.select().from(reports).where(eq(reports.id, id));
  if (!r) throw new AccessError("That report doesn't exist.");
  return asStored(r);
}

export async function reportsIn(tx: Tx, ctx: KernelCtx, chatId: string): Promise<StoredReport[]> {
  await mustBeAdmin(tx, ctx);
  const [chat] = await tx.select({ id: chats.id }).from(chats).where(eq(chats.id, chatId));
  if (!chat) throw new AccessError("That chat doesn't exist.");
  return (await tx.select().from(reports).where(eq(reports.chatId, chatId)).orderBy(asc(reports.ranAt))).map(asStored);
}

export async function recordDownload(tx: Tx, ctx: KernelCtx, r: StoredReport, kind: "csv" | "pdf") {
  await record(tx, ctx, { who: ctx.actor.email, event: "report.downloaded", details: { report: r.title, as: kind.toUpperCase() }, chatId: r.chatId });
}
