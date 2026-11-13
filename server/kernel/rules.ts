import { and, eq, isNull } from "drizzle-orm";
import { aiSteps, jobs, outbox, rows, waits } from "@/db/schema";
import type { AuditInput } from "./audit";
import type { CurrentFile, Work } from "./context";
import { evaluate } from "./expr/evaluate";
import { envFor, withOtherRows } from "./env";
import { rulesOn, sourceKey, type RuleEntry } from "./rule-set";
import type { Action, Rule, Sheet } from "./schema/file";
import { stepColumn } from "./steps";

// Rules run in the kernel, in the transaction of the write that triggered them (or in the daily job for date
// rules). No model call decides anything here: the same rows and the same files give the same result.
//
// - Rules on a sheet run in the order of the kernel's rule list (rule-set.ts): for rules from a file, the
//   file's order. A rule's actions run in order.
// - A rule acts with the authority the admin gave it by saving it: its writes follow the file (types, the
//   flow of steps) but not the role of the person whose write triggered it.
// - At most 3 levels: a rule triggered by a rule triggered by a rule. One more is not run, and its entry
//   says so.
// - Each run writes one rule.ran entry on its capability (who rule:<id>). A row it starts in another
//   capability is a connection.created entry there.

export const MAX_LEVELS = 3;

type Data = Record<string, unknown>;
export type RuleRow = { id: string; capabilityId: string; sheetId: string; data: Data; createdBy: string | null };

export type Trigger =
  | { kind: "created"; row: RuleRow } // row_created, and enters_step for the step it starts at
  | { kind: "updated"; row: RuleRow; changed: string[] } // field_changed
  | { kind: "moved"; row: RuleRow; to: string }; // enters_step

// missing: on an import only, required columns this row may leave empty (it waits on someone to fill them).
// history: on an import only, the row comes in as it was in the old system and runs no rules (a build).
export type WriteOpts = { audit?: boolean; asRule?: boolean; level?: number; quiet?: boolean; asImport?: boolean; newDocument?: boolean; skipChecks?: boolean; missing?: string[]; history?: boolean; kernel?: boolean };

// The kernel's own writes, passed in so rows.ts and this file don't import each other.
export type Writers = {
  create(w: Work, capId: string, sheetId: string, input: { values: Data; parentRowId?: string | null }, opts: WriteOpts): Promise<{ id: string; data: Data }>;
  update(w: Work, rowId: string, changes: Data, opts: WriteOpts): Promise<{ id: string; data: Data }>;
  move(w: Work, rowId: string, to: string, opts: WriteOpts): Promise<{ id: string; data: Data; from: string | null; to: string }>;
};

// level: the level of the rules about to run (1 for a person's write). quiet: from an import, so notify sends no email.
export type RunOpts = { level: number; quiet?: boolean };

function matches(rule: Rule, t: Trigger, sheet: Sheet): boolean {
  if (!rule.enabled || rule.trigger.sheet !== t.row.sheetId) return false;
  const tr = rule.trigger;
  const stepNow = (() => {
    const c = stepColumn(sheet);
    return c ? (t.row.data[c.id] as string | undefined) : undefined;
  })();
  switch (tr.kind) {
    case "row_created":
      return t.kind === "created";
    case "enters_step":
      return (t.kind === "created" && stepNow === tr.step) || (t.kind === "moved" && t.to === tr.step);
    case "field_changed":
      return t.kind === "updated" && !!tr.field && t.changed.includes(tr.field);
    case "date_reached":
    case "repeats":
      return false; // the daily job runs these
  }
}

// Runs every rule the write triggers. Returns what they did in other capabilities, for the write's own entry
// ("started 1 row in Onboarding").
export async function runRules(w: Work, t: Trigger, writers: Writers, opts: RunOpts): Promise<string[]> {
  const cap = w.loaded.files.get(t.row.capabilityId);
  const sheet = cap?.file.sheets.find((s) => s.id === t.row.sheetId);
  if (!cap || !sheet) return [];
  const elsewhere: string[] = [];
  for (const e of rulesOn(w.loaded.rules, cap.id, sheet.id)) {
    if (!matches(e.rule, t, sheet)) continue;
    elsewhere.push(...(await runRule(w, e, t.row.id, writers, opts)));
  }
  return elsewhere;
}

async function liveRow(w: Work, id: string): Promise<RuleRow | null> {
  const [r] = await w.tx.select().from(rows).where(and(eq(rows.id, id), isNull(rows.deletedAt)));
  return r ? { id: r.id, capabilityId: r.capabilityId, sheetId: r.sheetId, data: r.data as Data, createdBy: r.createdBy } : null;
}

// A row's name: its title column, a person by name, a linked row by that row's name (an interview is its
// candidate's name).
export async function titleOf(w: Work, sheet: Sheet, data: Data): Promise<string> {
  const col = sheet.columns.find((c) => c.id === sheet.titleColumn);
  const v = data[sheet.titleColumn];
  if (col?.type === "person" && typeof v === "string") return w.loaded.people.get(v)?.name ?? "";
  if (col?.type === "link" && col.link && typeof v === "string") {
    const target = await liveRow(w, v);
    const other = target && w.loaded.files.get(target.capabilityId)?.file.sheets.find((s) => s.id === target.sheetId);
    if (!target || !other) return "";
    const oc = other.columns.find((c) => c.id === other.titleColumn);
    const ov = target.data[other.titleColumn];
    return oc?.type === "person" && typeof ov === "string" ? (w.loaded.people.get(ov)?.name ?? "") : ov == null ? "" : String(ov);
  }
  return v === null || v === undefined ? "" : String(v);
}

// One rule on one row: its condition, then its actions. Used by writes and by the daily job.
export async function runRule(w: Work, e: RuleEntry, rowId: string, writers: Writers, opts: RunOpts): Promise<string[]> {
  const { rule } = e;
  const cap = w.loaded.files.get(e.capabilityId);
  const row = await liveRow(w, rowId);
  const sheet = cap?.file.sheets.find((s) => s.id === rule.trigger.sheet);
  if (!cap || !row || !sheet) return [];
  const rowTitle = await titleOf(w, sheet, row.data);
  // The row it ran on first, then any row it added or changed (0.4, M22: each row's History reads it).
  const entry = (did: string[], extra: Record<string, unknown> = {}, touched: string[] = []): AuditInput => ({
    who: `rule:${rule.id}`,
    capabilityId: cap.id,
    event: "rule.ran",
    details: { sheet: sheet.name, row: rowTitle, rule: rule.text, did: did.join("; ") || "nothing to change", ...extra },
    at: w.now,
    rows: [row.id, ...touched.filter((id) => id !== row.id)],
  });

  const data = await withOtherRows(w, cap, sheet, row.id, row.data);
  if (rule.condition && evaluate(rule.condition, await envFor(w, cap, sheet, row.id, data, [rule.condition])) !== true) return [];
  if (opts.level > MAX_LEVELS) {
    w.after.push(entry([], { stopped: `not run: more than ${MAX_LEVELS} rules in a row` }));
    return [];
  }

  const did: string[] = [];
  const elsewhere: string[] = [];
  const touched: string[] = [];
  const next: WriteOpts = { audit: false, asRule: true, level: opts.level + 1, quiet: opts.quiet };
  // Its entry comes before those of the rules it sets off, so the log reads in the order things were caused.
  const slot = w.after.push(entry([])) - 1;
  for (const action of rule.actions) {
    const current = (await liveRow(w, row.id)) ?? row;
    const full = await withOtherRows(w, cap, sheet, row.id, current.data);
    const r = await act(w, cap, sheet, e, action, { ...current, data: full }, writers, next, opts);
    if (r.did) did.push(r.did);
    if (r.elsewhere) elsewhere.push(r.elsewhere);
    if (r.touched) touched.push(r.touched);
  }
  w.after[slot] = entry(did, {}, touched);
  return elsewhere;
}

type Done = { did?: string; elsewhere?: string; touched?: string };

async function act(w: Work, cap: CurrentFile, sheet: Sheet, e: RuleEntry, a: Action, row: RuleRow, writers: Writers, next: WriteOpts, opts: RunOpts): Promise<Done> {
  const { rule } = e;
  const people = w.loaded.people;
  const name = (id: unknown) => (typeof id === "string" ? people.get(id)?.name : undefined);
  const stepCol = stepColumn(sheet);
  const stepName = (id: string) => sheet.steps?.find((s) => s.id === id)?.name ?? id;

  switch (a.kind) {
    case "move_to_step": {
      if (!stepCol || row.data[stepCol.id] === a.step) return {};
      const m = await writers.move(w, row.id, a.step, next);
      return { did: `moved ${m.from ? `${stepName(m.from)} → ` : ""}${stepName(a.step)}` };
    }

    case "create_row_in":
    case "update_row_in": {
      const targetCap = w.loaded.files.get(a.target.capability ?? cap.id);
      const targetSheet = targetCap?.file.sheets.find((s) => s.id === a.target.sheet);
      if (!targetCap || !targetSheet) return { did: `skipped: ${a.target.sheet} no longer exists` };
      const env = await envFor(w, cap, sheet, row.id, row.data, Object.values(a.map));
      const values = Object.fromEntries(Object.entries(a.map).map(([col, e]) => [col, evaluate(e, env)]));
      const copied = Object.keys(a.map).map((id) => targetSheet.columns.find((c) => c.id === id)?.name ?? id);
      const other = targetCap.id !== cap.id;

      if (a.kind === "create_row_in") {
        const made = await writers.create(w, targetCap.id, targetSheet.id, { values }, next);
        const title = await titleOf(w, targetSheet, made.data);
        if (other) {
          w.after.push({
            who: `rule:${rule.id}`,
            capabilityId: targetCap.id,
            event: "connection.created",
            details: { from: `${cap.file.name}/${sheet.name}/${await titleOf(w, sheet, row.data)}`, to: `${targetSheet.name}/${title}`, copied: `copied ${copied.join(", ")}` },
            at: w.now,
          });
          return { did: `started ${targetSheet.name}/${title} in ${targetCap.file.name}`, elsewhere: `started 1 row in ${targetCap.file.name}`, touched: made.id };
        }
        return { did: `added ${targetSheet.name}/${title}`, touched: made.id };
      }

      const targetId = row.data[a.via];
      if (typeof targetId !== "string" || !(await liveRow(w, targetId))) return { did: "skipped: no linked row" };
      // A step in the field map is a move along the flow; the rest is an edit.
      const step = stepColumn(targetSheet);
      const { [step?.id ?? ""]: to, ...rest } = values;
      const target = (await liveRow(w, targetId))!;
      const edits = Object.fromEntries(Object.entries(rest).filter(([col, v]) => JSON.stringify(target.data[col] ?? null) !== JSON.stringify(v ?? null)));
      const moves = !!step && typeof to === "string" && target.data[step.id] !== to;
      if (!Object.keys(edits).length && !moves) return {};
      if (Object.keys(edits).length) await writers.update(w, targetId, edits, next);
      if (moves) await writers.move(w, targetId, to as string, next);
      const title = await titleOf(w, targetSheet, target.data);
      return { did: `updated ${targetSheet.name}/${title}`, elsewhere: other ? `updated 1 row in ${targetCap.file.name}` : undefined, touched: targetId };
    }

    case "notify": {
      const ids = [...(a.people ?? []), ...(a.columns ?? []).map((c) => row.data[c])].filter((v): v is string => typeof v === "string" && people.has(v));
      const unique = [...new Set(ids)];
      if (!unique.length) return { did: "told nobody (no one named)" };
      // From an import, nobody is emailed: they see it in Waiting on me and the morning email.
      const rowTitle = await titleOf(w, sheet, row.data);
      if (!opts.quiet)
        await w.tx.insert(outbox).values(
          unique.map((personId) => ({
            workspaceId: w.ctx.workspaceId,
            personId,
            kind: "notify",
            payload: { message: a.message, capabilityId: cap.id, capability: cap.file.name, sheet: sheet.id, rowId: row.id, row: rowTitle },
            createdAt: w.now,
          })),
        );
      return { did: `told ${unique.map(name).join(", ")}${opts.quiet ? " (no email, from an import)" : ""}` };
    }

    case "ask_person": {
      const asked = await whoIsAsked(w, sheet, a, row);
      if (!asked) return { did: "asked nobody (no one named)" };
      let moved = "";
      if (a.step && stepCol && row.data[stepCol.id] !== a.step) {
        const m = await writers.move(w, row.id, a.step, next);
        moved = `moved ${m.from ? `${stepName(m.from)} → ` : ""}${stepName(a.step)}; `;
      }
      const at = a.step ?? (a.decision && stepCol ? ((row.data[stepCol.id] as string | undefined) ?? null) : null);
      const [open] = await w.tx
        .select({ id: waits.id })
        .from(waits)
        .where(and(eq(waits.rowId, row.id), eq(waits.ruleSource, sourceKey(e.source)), eq(waits.ruleId, rule.id), eq(waits.personId, asked.id), isNull(waits.clearedAt)));
      if (!open)
        await w.tx.insert(waits).values({
          workspaceId: w.ctx.workspaceId,
          capabilityId: cap.id,
          rowId: row.id,
          personId: asked.id,
          ruleSource: sourceKey(e.source),
          ruleId: rule.id,
          stepId: at,
          untilColumn: a.until ?? null,
          label: a.label ?? null,
          why: asked.why,
          decision: a.decision ?? null,
          createdAt: w.now,
        });
      return { did: `${moved}asked ${name(asked.id)}` };
    }

    case "ai_step": {
      const [step] = await w.tx
        .insert(aiSteps)
        .values({ workspaceId: w.ctx.workspaceId, capabilityId: cap.id, ruleSource: sourceKey(e.source), ruleId: rule.id, rowId: row.id, question: a.question, columnId: a.column ?? null, createdAt: w.now })
        .returning({ id: aiSteps.id });
      // The worker runs it once this write commits (a job, as queue.ts adds them).
      await w.tx.insert(jobs).values({ workspaceId: w.ctx.workspaceId, personId: null, kind: "ai-step", payload: { workspaceId: w.ctx.workspaceId, aiStepId: step!.id }, createdAt: w.now });
      return { did: "queued an AI step" };
    }
  }
}

// The one person an ask_person names, and why it is them, in words the panel shows (X1).
async function whoIsAsked(w: Work, sheet: Sheet, a: Extract<Action, { kind: "ask_person" }>, row: RuleRow): Promise<{ id: string; why: string | null } | null> {
  const people = w.loaded.people;
  const colName = (s: Sheet | undefined, id: string) => s?.columns.find((c) => c.id === id)?.name ?? id;
  if (a.person) return people.has(a.person) ? { id: a.person, why: null } : null;
  if (a.managerOf) {
    const of = people.get(String(row.data[a.managerOf] ?? ""));
    const manager = of?.managerId ? people.get(of.managerId) : undefined;
    return manager && of ? { id: manager.id, why: `you are ${of.name.split(" ")[0]}’s manager` } : null;
  }
  if (!a.column) return null;
  if (!a.via) {
    const id = row.data[a.column];
    return typeof id === "string" && people.has(id) ? { id, why: `you are its ${colName(sheet, a.column)}` } : null;
  }
  const link = sheet.columns.find((c) => c.id === a.via)?.link;
  const linkedId = row.data[a.via];
  if (!link || typeof linkedId !== "string") return null;
  const target = await liveRow(w, linkedId);
  const targetSheet = w.loaded.files.get(link.capability ?? row.capabilityId)?.file.sheets.find((s) => s.id === link.sheet);
  const id = target?.data[a.column];
  return typeof id === "string" && people.has(id)
    ? { id, why: `you are the ${colName(targetSheet, a.column)} of its ${colName(sheet, a.via)}` }
    : null;
}

// Writes the entries rules left for after the write's own entry, in the order they ran.
export async function flushRuleEntries(w: Work, record: (e: AuditInput) => Promise<void>) {
  const pending = w.after.splice(0);
  for (const e of pending) await record(e);
}
