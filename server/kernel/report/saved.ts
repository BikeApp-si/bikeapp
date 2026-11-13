import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { chats, reports, savedReports } from "@/db/schema";
import { formatDay } from "@/lib/format";
import { mustBeAdmin } from "../admin";
import { record } from "../audit";
import { currentTime } from "../clock";
import { AccessError, KernelError, load, todayIn, type KernelCtx } from "../context";
import { isDue, ordinal } from "../repeats";
import type { Tx } from "../tx";
import { capabilitiesOf, getReport } from "./store";
import { when } from "./view";

// M33 · Saved and scheduled reports. An admin saves a report they asked for (by its first run, so Run again's runs
// stay with it) and lists it on Reports. A saved report can be emailed to its author every day, every week on a
// weekday or every month on a day, at 07:00 in the company's time zone. Only the author reads, changes or gets it:
// RLS shows a saved report only to its author, and every call here checks it too. Each change is an Audit entry.

export type ReportEvery = { unit: "day" } | { unit: "week"; weekday: number } | { unit: "month"; day: number };

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY = 86_400_000;
const shift = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

// A schedule as it may be saved, or a plain reason it can't.
export function checkEvery(e: unknown): ReportEvery {
  const x = (e ?? {}) as { unit?: unknown; weekday?: unknown; day?: unknown };
  const whole = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
  if (x.unit === "day") return { unit: "day" };
  if (x.unit === "week" && whole(x.weekday, 1, 7)) return { unit: "week", weekday: x.weekday as number };
  if (x.unit === "month" && whole(x.day, 1, 31)) return { unit: "month", day: x.day as number };
  if (x.unit === "week") throw new KernelError("Choose a day of the week.");
  if (x.unit === "month") throw new KernelError("Choose a day of the month, from the 1st to the 31st.");
  throw new KernelError("Choose every day, every week or every month.");
}

// Is `day` one of the schedule's dates? A month without the day (the 31st in November) sends on its last day.
export const dueOn = (e: ReportEvery, day: string) => e.unit === "day" || isDue(e, day);

// "Every day", "Every Monday", "Every month on the 1st".
export const everyWords = (e: ReportEvery) =>
  e.unit === "day" ? "Every day" : e.unit === "week" ? `Every ${WEEKDAYS[e.weekday - 1]}` : `Every month on the ${ordinal(e.day)}`;

// The first date on or after `day` it is sent.
export function nextSend(e: ReportEvery, day: string): string {
  for (let i = 0; i < 31; i++) if (dueOn(e, shift(day, i))) return shift(day, i);
  return day;
}

// The date a send is owed for on `today`: the latest of the schedule's dates in the last week, not before the day the
// schedule was set. A day Bike was down is sent late, once; older ones are skipped.
export function owedOn(e: ReportEvery, since: string, today: string): string | null {
  for (let i = 0; i <= 7; i++) {
    const d = shift(today, -i);
    if (d < since) return null;
    if (dueOn(e, d)) return d;
  }
  return null;
}

// The first day a send can go out: today until its 07:00 has gone, then tomorrow. A schedule set at 09:00 on a Monday
// starts the Monday after, as the panel says, not at the next hourly run.
function firstSendDay(timeZone: string, now: Date): string {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now));
  const today = todayIn(timeZone, now);
  return hour >= 7 ? shift(today, 1) : today;
}

// The saved report for a run of mine, by its first run; refused for anyone else's report.
async function firstOf(tx: Tx, ctx: KernelCtx, reportId: string) {
  await mustBeAdmin(tx, ctx);
  const r = await getReport(tx, ctx, reportId); // RLS: only the author's chat, so only the author's runs
  const first = r.firstId ? await getReport(tx, ctx, r.firstId) : r;
  const [chat] = await tx.select({ authorId: chats.authorId }).from(chats).where(eq(chats.id, first.chatId));
  if (chat?.authorId !== ctx.actor.id) throw new AccessError("That report doesn't exist.");
  const [saved] = await tx.select().from(savedReports).where(and(eq(savedReports.firstId, first.id), eq(savedReports.authorId, ctx.actor.id)));
  return { first, saved };
}

const capabilityOf = async (tx: Tx, names: string[]) => [...(await load(tx)).files.values()].find((f) => f.file.name === names[0])?.id;

async function log(tx: Tx, ctx: KernelCtx, first: Awaited<ReturnType<typeof firstOf>>["first"], event: string, details: Record<string, unknown> = {}) {
  await record(tx, ctx, { who: ctx.actor.email, capabilityId: await capabilityOf(tx, capabilitiesOf(first.result)), event, details: { report: `“${first.title}”`, ...details }, chatId: first.chatId });
}

export async function saveForLater(tx: Tx, ctx: KernelCtx, reportId: string): Promise<void> {
  const { first, saved } = await firstOf(tx, ctx, reportId);
  if (saved && !saved.unsavedAt) return;
  const at = ctx.now ?? currentTime();
  if (saved) await tx.update(savedReports).set({ savedAt: at, unsavedAt: null }).where(eq(savedReports.id, saved.id));
  else await tx.insert(savedReports).values({ workspaceId: ctx.workspaceId, authorId: ctx.actor.id, chatId: first.chatId, firstId: first.id, savedAt: at });
  await log(tx, ctx, first, "report.saved");
}

// Unsaving stops its emails too.
export async function unsave(tx: Tx, ctx: KernelCtx, reportId: string): Promise<void> {
  const { first, saved } = await firstOf(tx, ctx, reportId);
  if (!saved || saved.unsavedAt) return;
  await tx.update(savedReports).set({ unsavedAt: ctx.now ?? currentTime(), every: null, everySince: null, stoppedWhy: null }).where(eq(savedReports.id, saved.id));
  await log(tx, ctx, first, "report.unsaved");
}

// every: null stops the emails.
export async function setSchedule(tx: Tx, ctx: KernelCtx, reportId: string, every: unknown | null): Promise<void> {
  const { first, saved } = await firstOf(tx, ctx, reportId);
  if (!saved || saved.unsavedAt) throw new KernelError("Save the report first.");
  if (every === null) {
    if (!saved.every) return;
    await tx.update(savedReports).set({ every: null, everySince: null, stoppedWhy: null }).where(eq(savedReports.id, saved.id));
    return log(tx, ctx, first, "report.unscheduled");
  }
  const e = checkEvery(every);
  const loaded = await load(tx);
  await tx.update(savedReports).set({ every: e, everySince: firstSendDay(loaded.timeZone, ctx.now ?? currentTime()), stoppedWhy: null }).where(eq(savedReports.id, saved.id));
  await log(tx, ctx, first, "report.scheduled", { every: everyWords(e) });
}

export type SavedState = { saved: boolean; every: ReportEvery | null; next: string | null };

// The panel's Save and schedule (m33-a, m33-b): saved or not, how often it's emailed, and the next date.
export async function savedState(tx: Tx, ctx: KernelCtx, reportId: string): Promise<SavedState> {
  const { saved } = await firstOf(tx, ctx, reportId);
  if (!saved || saved.unsavedAt) return { saved: false, every: null, next: null };
  const every = saved.stoppedWhy ? null : (saved.every as ReportEvery | null);
  if (!every) return { saved: true, every: null, next: null };
  const loaded = await load(tx);
  const next = nextSend(every, firstSendDay(loaded.timeZone, ctx.now ?? currentTime()));
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(`${next}T00:00:00Z`));
  return { saved: true, every, next: `${weekday}, ${formatDay(next, loaded.formats)}` };
}

export type SavedRow = { reportId: string; title: string; href: string; apps: string; emailed: string; lastRun: string; at: Date };

// Reports (m33-d): my saved reports, the one run most recently first, with its apps, how often it's emailed and its
// last run.
export async function listSaved(tx: Tx, ctx: KernelCtx): Promise<SavedRow[]> {
  await mustBeAdmin(tx, ctx);
  const saved = await tx.select().from(savedReports).where(and(eq(savedReports.authorId, ctx.actor.id), isNull(savedReports.unsavedAt)));
  if (!saved.length) return [];
  const firstIds = saved.map((s) => s.firstId);
  const runs = await tx.select().from(reports).where(inArray(reports.chatId, saved.map((s) => s.chatId))).orderBy(desc(reports.ranAt));
  const loaded = await load(tx);
  return saved
    .flatMap((s) => {
      const mine = runs.filter((r) => r.id === s.firstId || r.firstId === s.firstId);
      const last = mine[0];
      const first = mine.find((r) => r.id === s.firstId);
      if (!last || !first || !firstIds.includes(first.id)) return [];
      const every = s.stoppedWhy ? null : (s.every as ReportEvery | null);
      return [{ reportId: last.id, title: first.title, href: `/home?chat=${s.chatId}&report=${last.id}`, apps: capabilitiesOf(last.result as never).join(", "), emailed: every ? everyWords(every) : "", lastRun: when(last.ranAt, loaded.timeZone, false, loaded.formats), at: last.ranAt }];
    })
    .sort((a, b) => b.at.getTime() - a.at.getTime());
}
