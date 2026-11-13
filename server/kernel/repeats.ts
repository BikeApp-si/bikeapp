import { and, asc, eq, isNull } from "drizzle-orm";
import { capabilities, repeatRuns } from "@/db/schema";
import { formatDate, formatDay, formatMoney, US, type Formats } from "@/lib/format";
import { KernelError, startWork, type CurrentFile, type KernelCtx, type Work } from "./context";
import { ruleSavedOn } from "./date-rules";
import { evaluate } from "./expr/evaluate";
import { flush, WRITERS } from "./rows";
import { rulesOf, sourceKey, type RuleEntry } from "./rule-set";
import { titleOf, type Writers } from "./rules";
import type { Every, Rule, Sheet } from "./schema/file";
import { addToDate } from "./expr/evaluate";
import { renderExpr } from "./expr/render";
import { isRef, type Expr } from "./expr/ast";
import { atomic, type Tx } from "./tx";

// M32 · Rows that repeat: a rule with no row ("every month on the 1st, add the office rent to Expenses"), run by the
// daily job. Each date of its schedule from the day it was saved (or its start date, if later) up to today adds its
// rows once (repeat_runs), so a missed day catches up, one row per date, and nothing is added twice. A row's values
// are the rule's own: literals, people, and today, which reads as the date it was due, not the day the job ran.
// What it adds is sent by nobody, as an import is, unless the rule fills the sheet's creator column.

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY = 86_400_000;

const toTime = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1–12
const pad = (n: number) => String(n).padStart(2, "0");

export const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;

// Is `day` (YYYY-MM-DD) a date of the schedule?
export function isDue(every: Every, day: string): boolean {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  switch (every.unit) {
    case "week":
      return ((new Date(toTime(day)).getUTCDay() + 6) % 7) + 1 === every.weekday;
    case "month":
      return d === Math.min(every.day ?? 1, lastDay(y, m));
    case "year":
      return m === every.month && d === Math.min(every.day ?? 1, lastDay(y, m));
  }
}

// The schedule's dates from `from` to `to`, both included, oldest first.
export function datesFor(every: Every, from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = toTime(from); t <= toTime(to); t += DAY) if (isDue(every, iso(t))) out.push(iso(t));
  return out;
}

// The first date of the schedule on or after `day` (a year ahead at most: every schedule has one by then).
export function nextDate(every: Every, day: string, ends?: string): string | null {
  for (let t = toTime(day), stop = t + 366 * DAY; t <= stop; t += DAY) {
    const d = iso(t);
    if (ends && d > ends) return null;
    if (isDue(every, d)) return d;
  }
  return null;
}

// "Every month on the 1st", "Every week on Monday", "Every year on Mar 1" ("1 Mar" day first).
export function everyWords(every: Every, fmt: Formats = US): string {
  switch (every.unit) {
    case "week":
      return `Every week on ${WEEKDAYS[(every.weekday ?? 1) - 1]}`;
    case "month":
      return `Every month on the ${ordinal(every.day ?? 1)}`;
    case "year":
      return `Every year on ${formatDay(`2000-${pad(every.month ?? 1)}-${pad(every.day ?? 1)}`, fmt)}`;
  }
}

// The schedule with its start and end, as Customize's When reads it: "Every month on the 1st, from Nov 8, 2026".
export function scheduleWords(rule: Rule, since: string, fmt: Formats = US): string {
  const t = rule.trigger;
  const from = t.starts && t.starts > since ? t.starts : since;
  return `${everyWords(t.every!, fmt)}, from ${formatDate(from, fmt)}${t.ends ? ` until ${formatDate(t.ends, fmt)}` : ""}`;
}

export const isRepeat = (rule: Rule) => rule.trigger.kind === "repeats" && !!rule.trigger.every;

// The first day a repeating rule may add on: the later of the day it was saved and its start date.
export const firstDay = (rule: Rule, saved: string) => (rule.trigger.starts && rule.trigger.starts > saved ? rule.trigger.starts : saved);


// The values one date's row gets: the rule's own, with today read as that date.
export function valuesOn(map: Record<string, unknown>, on: string): Record<string, unknown> {
  const env = { today: on, value: () => null };
  return Object.fromEntries(Object.entries(map).map(([col, e]) => [col, evaluate(e as never, env)]));
}

// Adds one date's rows for a repeating rule, with its one `rule.ran` entry (before the entries of the rules its rows
// set off, so the log reads in the order things were caused). The rows go through the kernel's own write, at the
// first level of rules, so the sheet's rules run on them as on any added row.
async function addOn(w: Work, cap: CurrentFile, e: RuleEntry, on: string, writers: Writers): Promise<void> {
  const { rule } = e;
  const sheet = cap.file.sheets.find((s) => s.id === rule.trigger.sheet)!;
  const entry = (did: string[], touched: string[]) => ({
    who: `rule:${rule.id}`,
    capabilityId: cap.id,
    event: "rule.ran",
    details: { sheet: sheet.name, rule: rule.text, on, did: did.join("; ") || "nothing to add" },
    at: w.now,
    rows: touched,
  });
  const slot = w.after.push(entry([], [])) - 1;
  const did: string[] = [];
  const touched: string[] = [];
  for (const a of rule.actions) {
    if (a.kind !== "create_row_in") continue;
    const target = cap.file.sheets.find((s) => s.id === a.target.sheet);
    if (!target) {
      did.push(`skipped: ${a.target.sheet} no longer exists`);
      continue;
    }
    const made = await writers.create(w, cap.id, target.id, { values: valuesOn(a.map, on) }, { audit: false, asRule: true, level: 2 });
    did.push(`added ${target.name}/${await titleOf(w, target, made.data)}`);
    touched.push(made.id);
  }
  w.after[slot] = entry(did, touched);
}

// Runs every repeating rule due by `at` (its day in the workspace's time zone): apps in sidebar order, rules in
// file order, dates oldest first, so the same days give the same rows.
export async function runRepeats(tx: Tx, ctx: KernelCtx, opts: { capabilityId?: string } = {}): Promise<{ added: number }> {
  return atomic(tx, async (tx) => {
    const w = await startWork(tx, ctx);
    const order = await tx.select({ id: capabilities.id }).from(capabilities).where(isNull(capabilities.deletedAt)).orderBy(asc(capabilities.position));
    let added = 0;
    for (const { id } of order) {
      const cap = w.loaded.files.get(id);
      if (!cap || (opts.capabilityId && cap.id !== opts.capabilityId)) continue;
      for (const e of rulesOf(w.loaded.rules, cap.id)) {
        const { rule } = e;
        if (!rule.enabled || !isRepeat(rule) || e.source.kind !== "capability") continue;
        const saved = await ruleSavedOn(w, cap.id, rule.id);
        if (!saved) continue;
        const from = firstDay(rule, saved);
        const to = rule.trigger.ends && rule.trigger.ends < w.today ? rule.trigger.ends : w.today;
        const dates = datesFor(rule.trigger.every!, from, to);
        if (!dates.length) continue;
        const source = sourceKey(e.source);
        const already = new Set(
          (await tx.select({ on: repeatRuns.onDate }).from(repeatRuns).where(and(eq(repeatRuns.ruleSource, source), eq(repeatRuns.ruleId, rule.id)))).map((r) => r.on),
        );
        for (const on of dates) {
          if (already.has(on)) continue;
          const done = await tx
            .insert(repeatRuns)
            .values({ workspaceId: ctx.workspaceId, capabilityId: cap.id, ruleSource: source, ruleId: rule.id, onDate: on, ranAt: w.now })
            .onConflictDoNothing()
            .returning({ id: repeatRuns.id });
          if (!done.length) continue;
          // A row the kernel refuses (a value that no longer fits the sheet) is not added; the refusal is logged for
          // admins, the date stays done, and the other rules and dates go on.
          try {
            await atomic(tx, async () => {
              await addOn(w, cap, e, on, WRITERS);
              await flush(w);
            });
            added++;
          } catch (err) {
            if (!(err instanceof KernelError)) throw err;
            w.after.splice(0);
            const sheet = cap.file.sheets.find((s) => s.id === rule.trigger.sheet);
            w.after.push({ who: `rule:${rule.id}`, capabilityId: cap.id, event: "rule.ran", details: { sheet: sheet?.name ?? "", rule: rule.text, on, did: "nothing added", stopped: err.message }, at: w.now, rows: [] });
            await flush(w);
          }
        }
      }
    }
    return { added };
  });
}

// --- Customize's preview of a repeating rule (m32-a) -----------------------------------------------------------------

// The day of the schedule a row's date reads on ("The 1st", "Monday", "Mar 1").
const scheduleDay = (every: Every, fmt: Formats) =>
  every.unit === "week" ? WEEKDAYS[(every.weekday ?? 1) - 1]! : every.unit === "month" ? `The ${ordinal(every.day ?? 1)}` : formatDay(`2000-${pad(every.month ?? 1)}-${pad(every.day ?? 1)}`, fmt);

// One value of the row it adds, as a person reads it.
function valueWords(w: Work, sheet: Sheet, every: Every, col: string, e: Expr): { text: string; person?: boolean } {
  const c = sheet.columns.find((x) => x.id === col);
  const fmt = w.loaded.formats;
  if (isRef(e) && e.ref === "today") return { text: scheduleDay(every, fmt) };
  if (c?.type === "person" && typeof e === "string") return { text: w.loaded.people.get(e)?.name ?? "", person: true };
  if (c?.type === "choice" && typeof e === "string") return { text: c.options?.find((o) => o.id === e)?.name ?? e };
  if (c?.type === "money" && typeof e === "number") return { text: formatMoney(e, fmt) };
  if ((c?.type === "date" || c?.type === "datetime") && typeof e === "string") return { text: formatDate(e, fmt) };
  if (e === null || typeof e !== "object") return { text: e === null ? "—" : String(e) };
  return { text: renderExpr(e, { column: (id) => sheet.columns.find((x) => x.id === id), otherColumn: (sh, column) => ({ sheet: sh, column }), formats: fmt }) };
}

const listWords = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

export type RepeatPreview = {
  schedule: string; // "Every month on the 1st, from Nov 8, 2026"
  next: string | null; // "Dec 1, 2026"; null when it ends first
  columns: string[]; // the row it adds, in the sheet's column order
  values: { text: string; person?: boolean }[];
  past: number; // dates in the last 90 days, before today
  pastWords: string; // "Sep 1, Oct 1 and Nov 1, 2026"
};

// What a repeating rule would do from today, and on which of the last `days` days it would have added a row. Read
// only: nothing is added for the past dates.
export function previewRepeat(w: Work, sheet: Sheet, rule: Rule, days: number): RepeatPreview {
  const t = rule.trigger;
  const every = t.every!;
  const fmt = w.loaded.formats;
  const from = firstDay(rule, w.today);
  const map = (rule.actions.find((a) => a.kind === "create_row_in") as { map: Record<string, Expr> } | undefined)?.map ?? {};
  const cols = sheet.columns.filter((c) => c.id in map);
  const yesterday = addToDate(w.today, -1, "days");
  const past = datesFor(every, addToDate(w.today, -days, "days"), yesterday);
  const sameYear = past.length > 0 && past[0]!.slice(0, 4) === past.at(-1)!.slice(0, 4);
  const pastWords = sameYear ? `${listWords(past.map((d) => formatDay(d, fmt)))}, ${past[0]!.slice(0, 4)}` : listWords(past.map((d) => formatDate(d, fmt)));
  const next = nextDate(every, from, t.ends);
  return {
    schedule: scheduleWords(rule, w.today, fmt),
    next: next && formatDate(next, fmt),
    columns: cols.map((c) => c.name),
    values: cols.map((c) => valueWords(w, sheet, every, c.id, map[c.id]!)),
    past: past.length,
    pastWords,
  };
}
