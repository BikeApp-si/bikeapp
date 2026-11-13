import { and, asc, eq, gte, isNull, lte } from "drizzle-orm";
import { auditEntries, rows } from "@/db/schema";
import { mustBeAdmin } from "./admin";
import { KernelError, startWork, type CurrentFile, type KernelCtx, type Work } from "./context";
import { dateFor } from "./date-rules";
import { envFor, withOtherRows } from "./env";
import { addToDate, evaluate } from "./expr/evaluate";
import type { Action, Rule, Sheet } from "./schema/file";
import { checkRule } from "./rule-set";
import { isRepeat, previewRepeat, valuesOn, datesFor, type RepeatPreview } from "./repeats";
import type { Tx } from "./tx";

// What a rule would have done on the last 90 days, before it is saved (5j, 6f). Read-only: nothing is
// written. The kernel replays the rule over the rows and Audit log entries of those days; the AI never
// works it out. Conditions are checked against each row as it is now.

export const PREVIEW_DAYS = 90;

type Data = Record<string, unknown>;
export type PreviewItem = { rowId: string; title: string; on: string; did: string[] };
export type Preview = { items: PreviewItem[]; summary: string };

export const titleOf = (w: Work, sheet: Sheet, data: Data) => {
  const col = sheet.columns.find((c) => c.id === sheet.titleColumn);
  const v = data[sheet.titleColumn];
  if (col?.type === "person" && typeof v === "string") return w.loaded.people.get(v)?.name ?? "";
  return v === null || v === undefined ? "" : String(v);
};

// Each time the rule's trigger happened in the window: which row, on which day, with the row as read (and, for a
// date rule, its values worked out), so the preview doesn't read each row again (M12).
type Occasion = { rowId: string; on: string; data: Data; worked: boolean };
async function occasions(w: Work, cap: CurrentFile, sheet: Sheet, rule: Rule, from: string): Promise<Occasion[]> {
  const t = rule.trigger;
  const tz = w.loaded.timeZone;
  const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const live = await w.tx
    .select()
    .from(rows)
    .where(and(eq(rows.capabilityId, cap.id), eq(rows.sheetId, sheet.id), isNull(rows.deletedAt)))
    .orderBy(asc(rows.seq));
  const byTitle = new Map(live.map((r) => [titleOf(w, sheet, r.data as Data), r]));
  const start = new Date(`${from}T00:00:00Z`);

  if (t.kind === "date_reached") {
    const out: Occasion[] = [];
    for (const r of live) {
      const data = await withOtherRows(w, cap, sheet, r.id, r.data as Data);
      const on = dateFor(w, sheet, rule, data, r.createdAt);
      if (on && on >= from && on <= w.today) out.push({ rowId: r.id, on, data, worked: true });
    }
    return out;
  }
  // A new row enters the start step as it is added.
  if (t.kind === "row_created" || (t.kind === "enters_step" && sheet.steps?.find((s) => s.id === t.step)?.start))
    return live.filter((r) => r.createdAt >= start).map((r) => ({ rowId: r.id, on: day(r.createdAt), data: r.data as Data, worked: false }));
  // Moves and edits, as the Audit log recorded them (by the row's name).
  const event = t.kind === "enters_step" ? "row.step" : "row.updated";
  const entries = await w.tx
    .select()
    .from(auditEntries)
    .where(and(eq(auditEntries.capabilityId, cap.id), eq(auditEntries.event, event), gte(auditEntries.at, start), lte(auditEntries.at, w.now)))
    .orderBy(asc(auditEntries.seq));
  const out: Occasion[] = [];
  const stepName = sheet.steps?.find((s) => s.id === t.step)?.name;
  for (const e of entries) {
    const d = e.details as { sheet?: string; row?: string; to?: string; changes?: { column: string }[] };
    if (d.sheet !== sheet.name || !d.row) continue;
    const hit = t.kind === "enters_step" ? d.to === stepName : !!d.changes?.some((c) => c.column === t.field);
    const row = byTitle.get(d.row);
    if (hit && row) out.push({ rowId: row.id, on: day(e.at), data: row.data as Data, worked: false });
  }
  return out;
}

function describe(w: Work, cap: CurrentFile, sheet: Sheet, a: Action, data: Data): string {
  const name = (id: unknown) => (typeof id === "string" ? w.loaded.people.get(id)?.name : undefined);
  const step = (id: string | undefined) => sheet.steps?.find((s) => s.id === id)?.name ?? id;
  const target = "target" in a ? w.loaded.files.get(a.target.capability ?? cap.id) : undefined;
  switch (a.kind) {
    case "move_to_step":
      return `move it to ${step(a.step)}`;
    case "ask_person": {
      const who = a.person ? name(a.person) : a.managerOf ? name(w.loaded.people.get(String(data[a.managerOf] ?? ""))?.managerId) : a.via ? undefined : name(data[a.column ?? ""]);
      return `ask ${who ?? "the person it names"}${a.step ? ` at ${step(a.step)}` : ""}`;
    }
    case "create_row_in":
      return `start a row in ${target?.file.name ?? "another app"}`;
    case "update_row_in":
      return `update its row in ${target?.file.name ?? "another app"}`;
    case "notify":
      return `tell ${[...(a.people ?? []).map(name), ...(a.columns ?? []).map((c) => name(data[c]))].filter(Boolean).join(", ") || "nobody"}`;
    case "ai_step":
      return "queue an AI step";
  }
}

// The summary line, from the rule's first action: "On your last 90 days, this rule would have moved 3
// contracts to Renewal due."
function summarise(cap: CurrentFile, sheet: Sheet, rule: Rule, n: number): string {
  if (!n) return `On your last ${PREVIEW_DAYS} days, this rule wouldn't have run.`;
  const words = sheet.row ?? { one: "row", many: "rows" };
  const rowsWord = `${n} ${n === 1 ? words.one : words.many}`;
  const a = rule.actions[0]!;
  const step = (id: string | undefined) => sheet.steps?.find((s) => s.id === id)?.name ?? id;
  const lead = `On your last ${PREVIEW_DAYS} days, this rule would have`;
  switch (a.kind) {
    case "move_to_step":
      return `${lead} moved ${rowsWord} to ${step(a.step)}.`;
    case "ask_person":
      return a.step ? `${lead} moved ${rowsWord} to ${step(a.step)} for someone to act on.` : `${lead} asked someone about ${rowsWord}.`;
    case "create_row_in":
      return `${lead} started ${n} ${n === 1 ? "row" : "rows"} in ${a.target.capability && a.target.capability !== cap.id ? "another app" : sheet.name} from ${rowsWord}.`;
    case "update_row_in":
      return `${lead} updated the linked row of ${rowsWord}.`;
    case "notify":
      return `${lead} sent a reminder about ${rowsWord}.`;
    case "ai_step":
      return `${lead} queued an AI step for ${rowsWord}.`;
  }
}

// Admins only: a rule is previewed while it is being written, before anything is saved. The rule is checked
// on its own against the capability its trigger is on (rule-set.ts), so it can come from any source.
export async function previewRule(tx: Tx, ctx: KernelCtx, capId: string, rule: Rule): Promise<Preview> {
  await mustBeAdmin(tx, ctx);
  const w = await startWork(tx, ctx);
  return previewOn(w, capId, rule);
}

// The same, inside a call that already has its work (a plan's preview replays several rules).
export async function previewOn(w: Work, capId: string, rule: Rule): Promise<Preview> {
  const cap = w.loaded.files.get(capId);
  if (!cap) throw new KernelError("That app doesn't exist.");
  const errors = checkRule(w.loaded.files, new Set(w.loaded.people.keys()), capId, rule);
  if (errors.length) throw new KernelError("That rule isn't valid.", errors);
  const sheet = cap.file.sheets.find((s) => s.id === rule.trigger.sheet)!;

  const from = addToDate(w.today, -PREVIEW_DAYS, "days");
  const items: PreviewItem[] = [];
  // M32: a repeating rule has no row; its occasions are the dates of its schedule before today.
  if (isRepeat(rule)) {
    const words = sheet.row ?? { one: "row", many: "rows" };
    for (const on of datesFor(rule.trigger.every!, from, addToDate(w.today, -1, "days"))) {
      const added = rule.actions.flatMap((a) => (a.kind === "create_row_in" ? [titleOf(w, sheet, valuesOn(a.map, on))] : []));
      items.push({ rowId: "", title: added.join(", "), on, did: added.map((t) => `add ${t}`) });
    }
    const n = items.length;
    return { items, summary: n ? `On your last ${PREVIEW_DAYS} days, this rule would have added ${n} ${n === 1 ? words.one : words.many}.` : `On your last ${PREVIEW_DAYS} days, this rule wouldn't have added any.` };
  }
  for (const o of await occasions(w, cap, sheet, rule, from)) {
    const data = o.worked ? o.data : await withOtherRows(w, cap, sheet, o.rowId, o.data);
    if (rule.condition && evaluate(rule.condition, await envFor(w, cap, sheet, o.rowId, data, [rule.condition])) !== true) continue;
    items.push({ rowId: o.rowId, title: titleOf(w, sheet, data), on: o.on, did: rule.actions.map((a) => describe(w, cap, sheet, a, data)) });
  }
  items.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
  return { items, summary: summarise(cap, sheet, rule, items.length) };
}

// Customize's preview of one repeating rule (m32-a): its schedule, next date, the row it adds and its past dates.
export async function previewRepeatRule(tx: Tx, ctx: KernelCtx, capId: string, rule: Rule): Promise<RepeatPreview> {
  await mustBeAdmin(tx, ctx);
  const w = await startWork(tx, ctx);
  const cap = w.loaded.files.get(capId);
  if (!cap) throw new KernelError("That app doesn't exist.");
  const errors = checkRule(w.loaded.files, new Set(w.loaded.people.keys()), capId, rule);
  if (errors.length) throw new KernelError("That rule isn't valid.", errors);
  return previewRepeat(w, cap.file.sheets.find((s) => s.id === rule.trigger.sheet)!, rule, PREVIEW_DAYS);
}
