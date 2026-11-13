import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { auditEntries, outbox, people, rows, weeklyEmails } from "@/db/schema";
import { formatDay, US, type Formats } from "@/lib/format";
import { accessTo, unprime } from "./access";
import { mustBeAdmin } from "./admin";
import { capabilitiesFor } from "./capabilities";
import { currentTime } from "./clock";
import { load, startWork, todayIn, type KernelCtx } from "./context";
import type { Sheet } from "./schema/file";
import { atomic, withWorkspace, type Tx } from "./tx";
import { waitingForEveryone, waitingForOne } from "./waiting";

// What changed this week (0.5, M34): every Monday from 07:00, each admin gets one email about last week, Monday to
// Sunday in the company's time zone. The kernel counts it from the Audit log, for the apps that admin can see, and
// words it in fixed sentences; no AI. A quiet week still sends a short one. At most one per admin and week.

export type WeeklyLine = { app: string; text: string };
export type WeeklyWait = WeeklyLine & { title: string; capabilityId: string; sheetId: string; rowId: string };
export type Weekly = {
  weekOf: string; // the Monday
  through: string; // the Sunday
  range: string; // "Oct 19–25"
  days: string; // "Monday Oct 19 to Sunday Oct 25"
  added: WeeklyLine[]; // per app: added and moved on
  rules: string | null;
  stopped: WeeklyLine[];
  waiting: WeeklyWait[]; // the 3 that have waited longest
  quiet: boolean;
};

type Entry = { event: string; capabilityId: string | null; details: Record<string, unknown>; rowIds: string[] | null };

const DAY = 86_400_000;
export const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 Sunday, 1 Monday
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const listOf = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? ""));

// "Oct 19–25", "Oct 26–Nov 1"; "19–25 Oct" where days come first.
export function weekRange(weekOf: string, fmt: Formats = US): string {
  const end = addDays(weekOf, 6);
  const [a, b] = [formatDay(weekOf, fmt), formatDay(end, fmt)];
  const sameMonth = weekOf.slice(0, 7) === end.slice(0, 7);
  if (!sameMonth) return `${a}–${b}`;
  return fmt.dates === "dmy" ? `${a.split(" ")[0]}–${b}` : `${a}–${b.split(" ")[1]}`;
}

// Per app: "1 candidate and 6 interviews added · 2 moved on, 1 to Hired".
function appLine(sheets: Sheet[], entries: Entry[], sheetOfRow: Map<string, string>): string | null {
  const added = new Map<string, number>(); // sheet id → rows added
  let imported = 0;
  let moved = 0;
  const reached = new Map<string, number>(); // end step → moves into it
  const byName = (name: unknown) => sheets.find((s) => s.name === name);
  for (const e of entries) {
    if (e.event === "row.created") {
      const s = byName(e.details.sheet);
      if (s) added.set(s.id, (added.get(s.id) ?? 0) + 1);
    } else if (e.event === "import.done") {
      const n = Number(e.details.rows) || 0;
      const sheetId = (e.rowIds?.[0] && sheetOfRow.get(e.rowIds[0])) || sheets[0]?.id;
      if (sheetId && n) added.set(sheetId, (added.get(sheetId) ?? 0) + n);
      imported += n;
    } else if (e.event === "row.step") {
      moved++;
      const s = byName(e.details.sheet);
      const to = s?.steps?.find((x) => x.name === e.details.to);
      if (to?.end) reached.set(to.name, (reached.get(to.name) ?? 0) + 1);
    }
  }
  const parts: string[] = [];
  const total = [...added.values()].reduce((a, b) => a + b, 0);
  if (total) {
    const each = sheets.filter((s) => added.has(s.id)).map((s) => count(added.get(s.id)!, (s.row?.one ?? "row").toLowerCase(), (s.row?.many ?? "rows").toLowerCase()));
    parts.push(`${listOf(each)} added${imported ? `, ${imported.toLocaleString("en-US")} of them from imports` : ""}`);
  }
  if (moved) parts.push([`${moved.toLocaleString("en-US")} moved on`, ...[...reached].map(([step, n]) => `${n.toLocaleString("en-US")} to ${step}`)].join(", "));
  return parts.length ? parts.join(" · ") : null;
}

// A rule that stopped, or a scheduled report that couldn't be sent as it should, in fixed words.
function stoppedLine(e: Entry, fmt: Formats): string {
  const d = e.details;
  if (e.event === "report.unscheduled") return `${d.report} is no longer emailed: ${d.why}`;
  if (e.event === "report.emailed") return `${d.report} was emailed without its numbers: ${d.problem}`;
  const why = String(d.stopped);
  if (why.startsWith("not run: ")) return `“${d.rule}” didn't run on ${d.row}: ${why.slice("not run: ".length)}.`;
  if (typeof d.on === "string") return `“${d.rule}” added nothing on ${formatDay(d.on, fmt)}: ${why}`;
  return `“${d.rule}” stopped on ${d.row}: ${why}`;
}

// Last week as one admin sees it: the apps they can see, the rows they may read, their own reports' problems.
export async function weekSummary(tx: Tx, ctx: KernelCtx, weekOf: string): Promise<Weekly> {
  await mustBeAdmin(tx, ctx);
  const loaded = await load(tx);
  const now = ctx.now ?? currentTime();
  const apps = await capabilitiesFor(tx, ctx);
  const visible = new Set(apps.map((a) => a.id));
  const through = addDays(weekOf, 6);
  const tz = loaded.timeZone;
  const local = sql`(${auditEntries.at} at time zone ${tz})::date`;
  const entries: Entry[] = (
    await tx
      .select({ event: auditEntries.event, capabilityId: auditEntries.capabilityId, details: auditEntries.details, rowIds: auditEntries.rowIds, chatId: auditEntries.chatId })
      .from(auditEntries)
      .where(
        and(
          sql`${local} between ${weekOf}::date and ${through}::date`,
          inArray(auditEntries.event, ["row.created", "import.done", "row.step", "rule.ran", "report.unscheduled", "report.emailed"]),
          // A report's entry only for its author: chats are read through RLS, so another admin's chat isn't there.
          sql`(${auditEntries.event} not like 'report.%' or ${auditEntries.chatId} in (select id from chats))`,
        ),
      )
      .orderBy(asc(auditEntries.seq))
  ).map((e) => ({ ...e, details: e.details as Record<string, unknown> }));

  // Each named row must be one this admin may read.
  const rowIds = [...new Set(entries.flatMap((e) => e.rowIds ?? []))];
  const found = rowIds.length
    ? await tx.select({ id: rows.id, capabilityId: rows.capabilityId, sheetId: rows.sheetId, data: rows.data, parentRowId: rows.parentRowId }).from(rows).where(inArray(rows.id, rowIds))
    : [];
  const sheetOfRow = new Map(found.map((r) => [r.id, r.sheetId]));
  const accessCache = new Map<string, Awaited<ReturnType<typeof accessTo>>>();
  const accessOf = async (capId: string) => {
    if (!accessCache.has(capId)) accessCache.set(capId, await accessTo(tx, loaded, capId, ctx.actor.id));
    return accessCache.get(capId)!;
  };
  const seesRow = async (id: string) => {
    const r = found.find((x) => x.id === id);
    if (!r) return false;
    const a = await accessOf(r.capabilityId);
    return !!a && (await a.allows("see", { id: r.id, sheetId: r.sheetId, data: r.data as Record<string, unknown>, parentRowId: r.parentRowId }));
  };

  const added: WeeklyLine[] = [];
  const ran = new Map<string, number>();
  const stopped: WeeklyLine[] = [];
  for (const app of apps) {
    const mine = entries.filter((e) => e.capabilityId === app.id);
    const file = loaded.files.get(app.id)?.file;
    const line = file && appLine(file.sheets, mine, sheetOfRow);
    if (line) added.push({ app: app.name, text: line });
    const rules = mine.filter((e) => e.event === "rule.ran" && !e.details.stopped).length;
    if (rules) ran.set(app.name, rules);
  }
  for (const e of entries) {
    const isStop = (e.event === "rule.ran" && e.details.stopped) || e.event === "report.unscheduled" || (e.event === "report.emailed" && e.details.problem);
    if (!isStop) continue;
    if (e.capabilityId && !visible.has(e.capabilityId)) continue;
    if (e.event === "rule.ran" && e.rowIds?.length && !(await seesRow(e.rowIds[0]!))) continue;
    const app = apps.find((a) => a.id === e.capabilityId)?.name ?? "Reports";
    stopped.push({ app, text: stoppedLine(e, loaded.formats) });
  }

  const total = [...ran.values()].reduce((a, b) => a + b, 0);
  const each = [...ran].sort((a, b) => b[1] - a[1] || apps.findIndex((x) => x.name === a[0]) - apps.findIndex((x) => x.name === b[0]));
  const rules = !total ? null : each.length === 1 ? `Rules ran ${total === 1 ? "once" : `${total} times`}, in ${each[0]![0]}.` : `Rules ran ${total} times: ${listOf(each.map(([app, n]) => `${n} in ${app}`))}.`;

  const days = `Monday ${formatDay(weekOf, loaded.formats)} to Sunday ${formatDay(through, loaded.formats)}`;
  return { weekOf, through, range: weekRange(weekOf, loaded.formats), days, added, rules, stopped, waiting: await waitedLongest(tx, ctx, visible, now), quiet: !added.length && !total && !stopped.length };
}

// The 3 rows that have waited longest on someone, among those this admin may read; oldest first.
async function waitedLongest(tx: Tx, ctx: KernelCtx, visible: Set<string>, now: Date): Promise<WeeklyWait[]> {
  const w = await startWork(tx, { ...ctx, now });
  const snapshot = await waitingForEveryone(w);
  const all: { person: string; item: Awaited<ReturnType<typeof waitingForOne>>[number] }[] = [];
  try {
    for (const p of w.loaded.people.values()) for (const item of await waitingForOne(w, p.id, snapshot)) if (visible.has(item.capabilityId) && item.at <= now) all.push({ person: p.name, item });
  } finally {
    unprime(w.loaded);
  }
  all.sort((a, b) => a.item.at.getTime() - b.item.at.getTime() || a.item.title.localeCompare(b.item.title));
  const out: WeeklyWait[] = [];
  const access = new Map<string, Awaited<ReturnType<typeof accessTo>>>();
  for (const { person, item } of all) {
    if (out.length === 3) break;
    if (out.some((o) => o.rowId === item.rowId)) continue;
    const [row] = await tx.select({ data: rows.data, parentRowId: rows.parentRowId }).from(rows).where(eq(rows.id, item.rowId));
    if (!access.has(item.capabilityId)) access.set(item.capabilityId, await accessTo(tx, w.loaded, item.capabilityId, ctx.actor.id));
    const a = access.get(item.capabilityId);
    if (!row || !a || !(await a.allows("see", { id: item.rowId, sheetId: item.sheetId, data: row.data as Record<string, unknown>, parentRowId: row.parentRowId }))) continue;
    const days = Math.floor((now.getTime() - item.at.getTime()) / DAY);
    const long = days < 1 ? "since today" : count(days, "day");
    out.push({
      app: item.capability,
      title: item.title,
      text: `waits on ${person} · ${long}${item.step ? ` in ${item.step}` : ""}`,
      capabilityId: item.capabilityId,
      sheetId: item.sheetId,
      rowId: item.rowId,
    });
  }
  return out;
}

// From the hourly tick, as the job (no person): on a Monday from 07:00, each admin not yet emailed this week gets
// last week's summary, worked out as them. Written to the outbox, sent after it commits.
export async function queueWeeklyEmails(workspaceId: string, now = currentTime()): Promise<{ queued: number }> {
  const job = { workspaceId, personId: null };
  const due = await withWorkspace(job, async (tx) => {
    const today = todayIn((await load(tx)).timeZone, now);
    if (weekday(today) !== 1) return null;
    const weekOf = addDays(today, -7);
    const admins = await tx.select({ id: people.id, email: people.email }).from(people).where(eq(people.isAdmin, true)).orderBy(people.seq);
    const sent = new Set((await tx.select({ personId: weeklyEmails.personId }).from(weeklyEmails).where(eq(weeklyEmails.weekOf, weekOf))).map((s) => s.personId));
    return { weekOf, admins: admins.filter((a) => !sent.has(a.id)) };
  });
  if (!due?.admins.length) return { queued: 0 };
  const made: { personId: string; summary: Weekly }[] = [];
  for (const a of due.admins) {
    const ctx: KernelCtx = { workspaceId, actor: { id: a.id, email: a.email }, now };
    made.push({ personId: a.id, summary: await withWorkspace({ workspaceId, personId: a.id }, (tx) => weekSummary(tx, ctx, due.weekOf)) });
  }
  return withWorkspace(job, (tx) =>
    atomic(tx, async (tx) => {
      // Once per admin and week, even when two ticks overlap.
      const fresh = await tx
        .insert(weeklyEmails)
        .values(made.map((m) => ({ workspaceId, personId: m.personId, weekOf: due.weekOf, quiet: m.summary.quiet, sentAt: now })))
        .onConflictDoNothing()
        .returning({ personId: weeklyEmails.personId });
      const go = new Set(fresh.map((f) => f.personId));
      const mail = made.filter((m) => go.has(m.personId));
      if (mail.length) await tx.insert(outbox).values(mail.map((m) => ({ workspaceId, personId: m.personId, kind: "weekly", payload: m.summary, createdAt: now })));
      return { queued: mail.length };
    }),
  );
}
