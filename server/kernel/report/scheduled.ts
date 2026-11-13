import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { outbox, people, reports, reportSends, savedReports } from "@/db/schema";
import { record } from "../audit";
import { addMessage, updateMessage } from "../chats";
import { load, todayIn, type KernelCtx } from "../context";
import { atomic, withWorkspace } from "../tx";
import { runReport } from "./run";
import type { ReportResult } from "./schema";
import { everyWords, owedOn, type ReportEvery } from "./saved";
import { capabilitiesOf, getReport, saveReport } from "./store";
import { when } from "./view";

// M33 · The scheduled emails, from the hourly job at 07:00 and after in the company's time zone. Each saved report
// that is owed a send runs its query again as its author, with the author's access as of now: no AI, the kernel adds
// it up. The run is kept in its chat with a short reply in fixed words (m33-c), and the email with its PDF is queued
// in the outbox, so a refused send is tried again. Once per report and date (report_sends). An author who is no longer
// an admin gets nothing and the schedule stops; a query that can't run any more sends its plain reason instead.

export type ReportMail = { kind: "run"; reportId: string; every: string } | { kind: "refused"; title: string; chatId: string; reason: string; every: string };

const weekday = (day: string) => new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));

export async function sendScheduledReports(workspaceId: string, now: Date): Promise<{ sent: number }> {
  // Acting as nobody, the job reads every saved report in the workspace (RLS lets the job, and only the job, do that).
  const due = await withWorkspace({ workspaceId, personId: null }, async (tx) => {
    const loaded = await load(tx);
    const today = todayIn(loaded.timeZone, now);
    const list = await tx
      .select({ id: savedReports.id, authorId: savedReports.authorId, firstId: savedReports.firstId, chatId: savedReports.chatId, every: savedReports.every, since: savedReports.everySince, email: people.email, isAdmin: people.isAdmin })
      .from(savedReports)
      .innerJoin(people, eq(people.id, savedReports.authorId))
      .where(and(isNull(savedReports.unsavedAt), isNull(savedReports.stoppedWhy), isNotNull(savedReports.every)));
    const owed = list.flatMap((s) => {
      const on = owedOn(s.every as ReportEvery, s.since!, today);
      return on ? [{ ...s, on }] : [];
    });
    if (!owed.length) return [];
    const sent = await tx.select({ savedId: reportSends.savedId, on: reportSends.onDate }).from(reportSends).where(inArray(reportSends.savedId, owed.map((s) => s.id)));
    return owed.filter((s) => !sent.some((x) => x.savedId === s.id && x.on === s.on));
  });

  let count = 0;
  for (const s of due) {
    const ctx: KernelCtx = { workspaceId, actor: { id: s.authorId, email: s.email }, now };
    const every = everyWords(s.every as ReportEvery);
    await withWorkspace({ workspaceId, personId: s.authorId }, async (tx) => {
      // Read as the author through their own chat (RLS), so the entry names it even when they can't run it any more.
      const [own] = await tx.select({ title: reports.title, result: reports.result }).from(reports).where(eq(reports.id, s.firstId));
      const capabilityId = own ? [...(await load(tx)).files.values()].find((f) => f.file.name === capabilitiesOf(own.result as ReportResult)[0])?.id : undefined;
      const details = { report: `“${own?.title ?? ""}”` };
      const first = s.isAdmin ? await getReport(tx, ctx, s.firstId).catch(() => null) : null;
      if (!first) {
        const why = "Its author is no longer an admin.";
        await tx.update(savedReports).set({ stoppedWhy: why }).where(eq(savedReports.id, s.id));
        await record(tx, ctx, { who: "system", capabilityId, event: "report.unscheduled", details: { ...details, why }, chatId: s.chatId, at: now });
        return;
      }
      // In a savepoint: a query that fails leaves the rest of the send's transaction usable.
      const result = await atomic(tx, (t) => runReport(t, ctx, first.query, { asOf: now })).catch((e: Error) => e);
      if (result instanceof Error) {
        await tx.insert(reportSends).values({ workspaceId, savedId: s.id, onDate: s.on, refused: result.message, sentAt: now });
        const mail: ReportMail = { kind: "refused", title: first.title, chatId: s.chatId, reason: result.message, every };
        await tx.insert(outbox).values({ workspaceId, personId: s.authorId, kind: "report", payload: mail, createdAt: now });
        await record(tx, ctx, { who: ctx.actor.email, capabilityId, event: "report.emailed", details: { ...details, to: s.email, problem: result.message }, chatId: s.chatId, at: now });
        count++;
        return;
      }
      const loaded = await load(tx);
      const text = `Emailed to you: as of ${weekday(todayIn(loaded.timeZone, now))}, ${when(now, loaded.timeZone, false, loaded.formats)}.`;
      const messageId = await addMessage(tx, ctx, s.chatId, { from: "bike", text });
      const run = await saveReport(tx, ctx, { chatId: s.chatId, messageId, firstId: first.id, title: first.title, query: first.query, chart: first.chart, series: first.series, how: first.how, missing: first.missing, sentence: text, result, ranAt: now });
      await updateMessage(tx, ctx, messageId, { parts: [{ kind: "report", reportId: run.id, brief: true }] });
      await tx.insert(reportSends).values({ workspaceId, savedId: s.id, onDate: s.on, reportId: run.id, sentAt: now });
      const mail: ReportMail = { kind: "run", reportId: run.id, every };
      await tx.insert(outbox).values({ workspaceId, personId: s.authorId, kind: "report", payload: mail, createdAt: now });
      await record(tx, ctx, { who: ctx.actor.email, capabilityId, event: "report.emailed", details: { ...details, to: s.email }, chatId: s.chatId, at: now });
      count++;
    });
  }
  return { sent: count };
}
