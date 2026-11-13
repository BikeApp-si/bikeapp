import { and, asc, eq, isNull } from "drizzle-orm";
import { sameJson } from "@/lib/same-json";
import { ruleRuns, rows } from "@/db/schema";
import { formatMoney } from "@/lib/format";
import type { Work } from "../context";
import { baseDateFor, ruleSavedOn } from "../date-rules";
import { envFor, withOtherRows } from "../env";
import { isCol, isOp } from "../expr/ast";
import { addToDate, evaluate } from "../expr/evaluate";
import { titleOf } from "../preview";
import { sourceKey } from "../rule-set";
import type { CapabilityFile, Rule, Sheet } from "../schema/file";
import { stepColumn } from "../steps";
import { accessLines } from "./sheet-access";

// What a Customize change does to today's rows (6c, 6h), worked out by the kernel from the rows and the run log;
// the AI never computes it. Read-only: nothing is written.

type Data = Record<string, unknown>;
const words = (s: Sheet) => s.row ?? { one: "row", many: "rows" };
const and_ = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? ""));

export type Impact = {
  // Rows at the step before a new conditional step that meet its condition: they stop there on their next move.
  waits: { step: string; next: string | null; rows: { title: string; value: string | null; now: string }[] }[];
  // Date rules, new or changed, that will act on rows at the next daily run (a changed rule catches up once).
  fires: { ruleId: string; first: Rule["actions"][number]["kind"]; step: string | null; rows: string[] }[];
  // Steps renamed that hold rows: they stay where they are under the new name.
  renamed: { from: string; to: string; count: number; rows: { one: string; many: string } }[];
  // Who sees a sheet differently, or a new sheet, in plain words (C1).
  access: string[];
};

async function liveRows(w: Work, capId: string, sheetId: string) {
  return w.tx
    .select()
    .from(rows)
    .where(and(eq(rows.capabilityId, capId), eq(rows.sheetId, sheetId), isNull(rows.deletedAt)))
    .orderBy(asc(rows.seq));
}

export async function impactOf(w: Work, capId: string, before: CapabilityFile, after: CapabilityFile): Promise<Impact> {
  const cap = w.loaded.files.get(capId)!;
  const out: Impact = { waits: [], fires: [], renamed: [], access: accessLines(before, after) };

  for (const sheet of after.sheets) {
    const was = before.sheets.find((s) => s.id === sheet.id);
    const stepCol = stepColumn(sheet);
    if (!was || !stepCol) continue;
    const steps = sheet.steps ?? [];
    const live = await liveRows(w, capId, sheet.id);
    for (const [i, st] of steps.entries()) {
      const old = was.steps?.find((x) => x.id === st.id);
      if (old && old.name !== st.name) {
        const count = live.filter((r) => (r.data as Data)[stepCol.id] === st.id).length;
        if (count) out.renamed.push({ from: old.name, to: st.name, count, rows: words(sheet) });
      }
      if (old || !st.onlyWhen || i === 0) continue;
      const prev = steps[i - 1]!;
      // The value the condition reads, shown beside the row ("$57,600").
      const e = st.onlyWhen;
      const col = isOp(e) && isCol(e.args[0]!) ? sheet.columns.find((c) => c.id === (e.args[0] as { col: string }).col) : undefined;
      const waiting = [];
      for (const r of live.filter((x) => (x.data as Data)[stepCol.id] === prev.id)) {
        const data = await withOtherRows(w, cap, sheet, r.id, r.data as Data);
        if (evaluate(e, await envFor(w, cap, sheet, r.id, data, [e])) !== true) continue;
        const v = col ? data[col.id] : null;
        waiting.push({ title: titleOf(w, sheet, data), value: col?.type === "money" && typeof v === "number" ? formatMoney(v, w.loaded.formats) : v === null || v === undefined ? null : String(v), now: prev.name });
      }
      if (waiting.length) out.waits.push({ step: st.name, next: steps.slice(i + 1).find((x) => !x.end)?.name ?? null, rows: waiting });
    }
  }

  // Date rules that are new or changed: the rows the next daily run acts on, as runDateRules would.
  for (const rule of after.rules) {
    const old = before.rules.find((r) => r.id === rule.id);
    if (!rule.enabled || rule.trigger.kind !== "date_reached" || (old && sameJson(old, rule))) continue;
    const sheet = after.sheets.find((s) => s.id === rule.trigger.sheet);
    if (!sheet) continue;
    // A changed rule keeps its first save; a new one is saved today, so only today's date would fire.
    const since = (old && (await ruleSavedOn(w, capId, rule.id))) || w.today;
    const hit: string[] = [];
    for (const r of await liveRows(w, capId, sheet.id)) {
      const data = await withOtherRows(w, cap, sheet, r.id, r.data as Data);
      const base = baseDateFor(w, sheet, rule, data, r.createdAt);
      const on = base && addToDate(base, rule.trigger.offsetDays ?? 0, "days");
      if (!base || !on || on < since || on > w.today) continue;
      const [ran] = await w.tx
        .select({ id: ruleRuns.id })
        .from(ruleRuns)
        .where(and(eq(ruleRuns.ruleSource, sourceKey({ kind: "capability", capabilityId: capId, version: cap.version })), eq(ruleRuns.ruleId, rule.id), eq(ruleRuns.rowId, r.id), eq(ruleRuns.baseDate, base)));
      if (ran) continue;
      if (rule.condition !== undefined && evaluate(rule.condition, await envFor(w, cap, sheet, r.id, data, [rule.condition])) !== true) continue;
      hit.push(titleOf(w, sheet, data));
    }
    const first = rule.actions[0]!;
    const step = first.kind === "move_to_step" || first.kind === "ask_person" ? (sheet.steps?.find((s) => s.id === first.step)?.name ?? null) : null;
    if (hit.length) out.fires.push({ ruleId: rule.id, first: first.kind, step, rows: hit });
  }
  return out;
}

// The impact in plain words, for the preview reply. Empty when nothing changes for today's rows.
export function impactText(i: Impact): string {
  const out: string[] = [];
  const waiting = i.waits.flatMap((x) => x.rows.map((r) => ({ ...r, step: x.step, next: x.next })));
  if (waiting.length) {
    const who = and_(waiting.map((r) => `**${r.title}** (${[r.value, `now ${r.now}`].filter(Boolean).join(", ")})`));
    const w0 = waiting[0]!;
    out.push(`Today this affects ${who}: ${waiting.length === 1 ? "it" : "they"} will wait in ${w0.step}${w0.next ? ` before ${waiting.length === 1 ? "it becomes" : "they become"} ${w0.next}` : ""}.`);
  }
  for (const f of i.fires) {
    const titles = and_(f.rows);
    const verb = f.first === "notify" || f.first === "ask_person" ? `will get ${f.rows.length === 1 ? "its" : "their"} reminder today` : f.first === "move_to_step" && f.step ? `will move to ${f.step} today` : "will be acted on today";
    out.push(`${titles} ${verb}.`);
  }
  for (const r of i.renamed) out.push(`The ${r.count} ${r.count === 1 ? r.rows.one : r.rows.many} already ${r.from} stay as they are and become ${r.to}.`);
  out.push(...i.access);
  return out.join(" ");
}
