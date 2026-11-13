import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { outbox, people, workspaces } from "@/db/schema";
import { runDateRules, systemCtx } from "@/server/kernel/date-rules";
import { runRepeats } from "@/server/kernel/repeats";
import { queueMorningEmails, type MorningItem } from "@/server/kernel/morning";
import { withWorkspace } from "@/server/kernel/tx";
import { send } from "@/server/email/send";
import { morningEmail } from "@/server/email/templates/morning";
import { weeklyEmail } from "@/server/email/templates/weekly";
import { queueWeeklyEmails, type Weekly } from "@/server/kernel/weekly";
import { notifyEmail, type NotifyPayload } from "@/server/email/templates/notify";
import { readyEmail, type ReadyPayload } from "@/server/email/templates/ready";
import { markUrl } from "@/server/email/templates/header";
import { workspaceLogo } from "@/server/kernel/settings";
import { currentTime } from "@/server/kernel/clock";
import { AccessError, load, todayIn } from "@/server/kernel/context";
import { sendScheduledReports, type ReportMail } from "@/server/kernel/report/scheduled";
import { getReport } from "@/server/kernel/report/store";
import { reportView } from "@/server/kernel/report/view";
import { reportHtml, reportPdf } from "@/server/report/pdf";
import { reportEmail, reportRefusedEmail } from "@/server/email/templates/report";

// The worker's jobs. Every hour each workspace is checked in its own time zone: from 06:00 its repeating rules add
// their rows, then its date rules run (both catching up on anything missed), from 07:00 its morning emails are queued,
// and on a Monday the admins' What changed this week (M34). Both are safe to run again: a
// rule runs once per row and date, a repeating rule once per date, a person gets one morning email a day. The outbox is sent every minute.

const hourIn = (timeZone: string, now: Date) => Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now));

// only: one workspace (tests); every workspace when left out.
type Only = { workspaceId?: string };

async function allWorkspaces(only: Only): Promise<{ id: string; timeZone: string }[]> {
  const found = await db().execute<{ id: string; time_zone: string }>(sql`select * from all_workspaces()`);
  return [...found].filter((w) => !only.workspaceId || w.id === only.workspaceId).map((w) => ({ id: w.id, timeZone: w.time_zone }));
}

// One workspace's trouble never holds up the others; the job fails afterwards, so pg-boss runs it again.
async function eachWorkspace(only: Only, fn: (ws: { id: string; timeZone: string }) => Promise<void>) {
  const failed: unknown[] = [];
  for (const ws of await allWorkspaces(only)) {
    try {
      await fn(ws);
    } catch (e) {
      console.error(`Workspace ${ws.id}:`, e);
      failed.push(e);
    }
  }
  if (failed.length) throw new AggregateError(failed, `${failed.length} workspace(s) failed`);
}

export async function tick(now = currentTime(), only: Only = {}) {
  await eachWorkspace(only, async (ws) => {
    const hour = hourIn(ws.timeZone, now);
    const as = { workspaceId: ws.id, personId: null };
    if (hour >= 6) await withWorkspace(as, (tx) => runRepeats(tx, systemCtx(ws.id, now)));
    if (hour >= 6) await withWorkspace(as, (tx) => runDateRules(tx, systemCtx(ws.id, now)));
    if (hour >= 7) await withWorkspace(as, (tx) => queueMorningEmails(tx, systemCtx(ws.id, now)));
    if (hour >= 7) await sendScheduledReports(ws.id, now);
    if (hour >= 7) await queueWeeklyEmails(ws.id, now);
  });
}

// Sends what the outbox holds, one email at a time, marking each as sent once it has gone.
export async function sendOutbox(only: Only = {}) {
  await eachWorkspace(only, async (ws) => {
    const as = { workspaceId: ws.id, personId: null };
    const waiting = await withWorkspace(as, async (tx) => {
      const [w] = await tx.select({ name: workspaces.name, subdomain: workspaces.subdomain }).from(workspaces);
      const items = await tx
        .select({ id: outbox.id, kind: outbox.kind, payload: outbox.payload, personId: outbox.personId, email: people.email, name: people.name })
        .from(outbox)
        .innerJoin(people, eq(people.id, outbox.personId))
        .where(isNull(outbox.sentAt))
        .orderBy(asc(outbox.createdAt));
      return { w: w!, mark: markUrl({ subdomain: w!.subdomain, logoId: await workspaceLogo(tx) }), items };
    });
    for (const item of waiting.items) {
      const firstName = item.name.split(" ")[0]!;
      const email =
        item.kind === "report"
          ? await reportMail(ws.id, item, waiting.w, waiting.mark).catch((e: Error) => {
              // Its author can't read it any more (no longer an admin): it is dropped, not tried every minute.
              console.error(`Report email ${item.id} not built: ${e.message}`);
              return e instanceof AccessError ? null : undefined;
            })
          : item.kind === "weekly"
          ? weeklyEmail({ to: item.email, firstName, company: waiting.w.name, subdomain: waiting.w.subdomain, mark: waiting.mark, week: item.payload as Weekly })
          : item.kind === "morning"
          ? morningEmail({ to: item.email, firstName, company: waiting.w.name, subdomain: waiting.w.subdomain, mark: waiting.mark, ...(item.payload as { date: string; items: MorningItem[] }) })
          : item.kind === "ready"
            ? readyEmail({ to: item.email, subdomain: waiting.w.subdomain, mark: waiting.mark, payload: item.payload as ReadyPayload })
            : notifyEmail({ to: item.email, subdomain: waiting.w.subdomain, mark: waiting.mark, payload: item.payload as NotifyPayload });
      if (email === undefined) continue;
      if (email === null) {
        await withWorkspace(as, (tx) => tx.update(outbox).set({ sentAt: currentTime() }).where(and(eq(outbox.id, item.id), isNull(outbox.sentAt))));
        continue;
      }
      // A refused email stays unsent and is tried again next minute; the others still go out.
      const sent = await send(email).then(
        () => true,
        (e: Error) => (console.error(`Email ${item.id} to ${item.email} not sent: ${e.message}`), false),
      );
      if (sent) await withWorkspace(as, (tx) => tx.update(outbox).set({ sentAt: currentTime() }).where(and(eq(outbox.id, item.id), isNull(outbox.sentAt))));
    }
  });
}

// A scheduled report's email (m33-e), built as its author: the run's table, and its PDF printed as the panel's.
async function reportMail(workspaceId: string, item: { personId: string; email: string; payload: unknown }, w: { name: string; subdomain: string }, mark: string) {
  const p = item.payload as ReportMail;
  if (p.kind === "refused") return reportRefusedEmail({ to: item.email, subdomain: w.subdomain, mark, title: p.title, chatId: p.chatId, reason: p.reason, every: p.every });
  const ctx = { workspaceId, actor: { id: item.personId, email: item.email } };
  const made = await withWorkspace({ workspaceId, personId: item.personId }, async (tx) => {
    const r = await getReport(tx, ctx, p.reportId);
    const loaded = await load(tx);
    const words = (sheet: string) => [...loaded.files.values()].flatMap((f) => f.file.sheets).find((s) => s.name === sheet)?.row ?? { one: "row", many: "rows" };
    const view = reportView(r, words, loaded.timeZone, undefined, loaded.formats);
    const day = todayIn(loaded.timeZone, r.ranAt);
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
    return { view, chatId: r.chatId, by: loaded.people.get(r.ranAs)?.name ?? "", asOf: `${weekday}, ${view.ranAt}` };
  });
  const html = await reportHtml(made.view, { by: made.by, workspace: w.name, address: `${w.subdomain}.${process.env.ROOT_HOST ?? "bikeapp.si"}` });
  const read = made.view.card.split(" · ").at(-1) ?? "";
  return reportEmail({ to: item.email, subdomain: w.subdomain, mark, view: made.view, asOf: made.asOf, read, every: p.every, pdf: await reportPdf(html), chatId: made.chatId });
}
