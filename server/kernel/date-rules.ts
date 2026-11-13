import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { capabilities, capabilityVersions, companyRules, ruleRuns, rows } from "@/db/schema";
import { startWork, todayIn, type CurrentFile, type KernelCtx, type Work } from "./context";
import { withOtherRows } from "./env";
import { addToDate } from "./expr/evaluate";
import { flush, WRITERS } from "./rows";
import { rulesOf, sourceKey, type RuleEntry } from "./rule-set";
import { runRule } from "./rules";
import type { Rule, Sheet } from "./schema/file";
import type { CompanyRule } from "./schema/company";
import { atomic, type Tx } from "./tx";

// Date rules ("60 days before a contract's notice date"), run by the daily job at 06:00 workspace time.
// Every date that has passed is caught up, so a missed day loses nothing, but only dates on or after the day
// the rule was saved: older ones never fire (the preview on past rows shows them instead). A rule runs at
// most once per row and base date (rule_runs: the date it counts from, such as the notice date), whatever its
// condition said, so nothing runs twice. A rule changed in Customize keeps its id and its first save, so moving
// it earlier (60 → 90 days) catches up the rows whose new date has passed, and a row it already reminded for
// that notice date isn't reminded again.

// Who acts for the daily job: nobody in People. Its writes are the rules' own.
export const SYSTEM_ID = "00000000-0000-0000-0000-000000000000";
export const systemCtx = (workspaceId: string, now: Date): KernelCtx => ({ workspaceId, actor: { id: SYSTEM_ID, email: "system" }, now });

// The day the rule was saved, from its source. For a rule in a capability's file: the day the version that
// added it was saved, the earliest of the versions, back from the current one, that all have it. For a company
// rule: the same, over the company's rule versions, for the part on this capability.
const savedOn = (w: Work, e: RuleEntry) => (e.source.kind === "capability" ? ruleSavedOn(w, e.source.capabilityId, e.rule.id) : companyRuleSavedOn(w, e.source.ruleId, e.rule.id));

async function companyRuleSavedOn(w: Work, ruleId: string, partId: string): Promise<string | null> {
  const versions = await w.tx.select({ rules: companyRules.rules, at: companyRules.createdAt }).from(companyRules).orderBy(desc(companyRules.version));
  let since: Date | null = null;
  for (const v of versions) {
    if (!(v.rules as CompanyRule[]).some((r) => r.id === ruleId && r.applications.some((a) => a.id === partId))) break;
    since = v.at;
  }
  return since ? todayIn(w.loaded.timeZone, since) : null;
}

// The same for a rule by id; null when no saved version has it (a rule not saved yet).
export async function ruleSavedOn(w: Work, capabilityId: string, ruleId: string): Promise<string | null> {
  const versions = await w.tx
    .select({ file: capabilityVersions.file, at: capabilityVersions.createdAt })
    .from(capabilityVersions)
    .where(eq(capabilityVersions.capabilityId, capabilityId))
    .orderBy(desc(capabilityVersions.version));
  let since: Date | null = null;
  for (const v of versions) {
    if (!(v.file as { rules: Rule[] }).rules.some((r) => r.id === ruleId)) break;
    since = v.at;
  }
  return since ? todayIn(w.loaded.timeZone, since) : null;
}

// The date a row's rule counts from: its date column (a date, or the day of a date and time in the
// workspace's time zone), or the day the row was added.
export function baseDateFor(w: Work, sheet: Sheet, rule: Rule, data: Record<string, unknown>, addedAt: Date): string | null {
  if (rule.trigger.from === "added") return todayIn(w.loaded.timeZone, addedAt);
  const v = data[rule.trigger.date ?? ""];
  if (typeof v !== "string") return null;
  const col = sheet.columns.find((c) => c.id === rule.trigger.date);
  return col?.type === "datetime" ? todayIn(w.loaded.timeZone, new Date(v)) : v.slice(0, 10);
}

// The date it counts to: that date plus the rule's offset.
export function dateFor(w: Work, sheet: Sheet, rule: Rule, data: Record<string, unknown>, addedAt: Date): string | null {
  const base = baseDateFor(w, sheet, rule, data, addedAt);
  return base && addToDate(base, rule.trigger.offsetDays ?? 0, "days");
}

async function capsInOrder(w: Work): Promise<CurrentFile[]> {
  const order = await w.tx.select({ id: capabilities.id }).from(capabilities).where(isNull(capabilities.deletedAt)).orderBy(asc(capabilities.position));
  return order.map((c) => w.loaded.files.get(c.id)).filter((c): c is CurrentFile => !!c);
}

// Runs every date rule due by `at` (its day in the workspace's time zone). Capabilities in sidebar order,
// rules in list order (a file's order), rows in the order they were written: the same rows give the same runs.
export async function runDateRules(tx: Tx, ctx: KernelCtx, opts: { capabilityId?: string } = {}): Promise<{ ran: number }> {
  return atomic(tx, async (tx) => {
    const w = await startWork(tx, ctx);
    let ran = 0;
    for (const cap of await capsInOrder(w)) {
      if (opts.capabilityId && cap.id !== opts.capabilityId) continue;
      for (const e of rulesOf(w.loaded.rules, cap.id)) {
        const { rule } = e;
        if (!rule.enabled || rule.trigger.kind !== "date_reached") continue;
        const sheet = cap.file.sheets.find((s) => s.id === rule.trigger.sheet);
        const since = await savedOn(w, e);
        if (!sheet || !since) continue;
        const found = await tx
          .select()
          .from(rows)
          .where(and(eq(rows.capabilityId, cap.id), eq(rows.sheetId, sheet.id), isNull(rows.deletedAt)))
          .orderBy(asc(rows.seq));
        // What this rule already ran for, read once (M12): a past date is passed over without a write, instead of
        // one refused insert per row every day. The insert below still refuses a second run on its own.
        const source = sourceKey(e.source);
        const already = new Set(
          (await tx.select({ rowId: ruleRuns.rowId, base: ruleRuns.baseDate }).from(ruleRuns).where(and(eq(ruleRuns.ruleSource, source), eq(ruleRuns.ruleId, rule.id)))).map(
            (r) => `${r.rowId}|${r.base}`,
          ),
        );
        // A stored date column needs no working out; a computed one may read today or other rows.
        const dateColumn = sheet.columns.find((c) => c.id === rule.trigger.date);
        const stored = rule.trigger.from === "added" || (!!dateColumn && dateColumn.type !== "computed");
        for (const row of found) {
          const data = stored ? (row.data as Record<string, unknown>) : await withOtherRows(w, cap, sheet, row.id, row.data as Record<string, unknown>);
          const base = baseDateFor(w, sheet, rule, data, row.createdAt);
          const on = base && addToDate(base, rule.trigger.offsetDays ?? 0, "days");
          if (!base || !on || on < since || on > w.today || already.has(`${row.id}|${base}`)) continue;
          const done = await tx
            .insert(ruleRuns)
            .values({ workspaceId: ctx.workspaceId, capabilityId: cap.id, ruleSource: source, ruleId: rule.id, rowId: row.id, baseDate: base, onDate: on, ranAt: w.now })
            .onConflictDoNothing()
            .returning({ id: ruleRuns.id });
          if (!done.length) continue;
          await runRule(w, e, row.id, WRITERS, { level: 1 });
          await flush(w);
          ran++;
        }
      }
    }
    return { ran };
  });
}
