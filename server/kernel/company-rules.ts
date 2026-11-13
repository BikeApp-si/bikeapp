import { companyRules as companyRulesTable } from "@/db/schema";
import { sameJson } from "@/lib/same-json";
import { mustBeAdmin } from "./admin";
import { record } from "./audit";
import { KernelError, load, startWork, type KernelCtx, type Loaded } from "./context";
import { accessTo } from "./access";
import { previewOn, type Preview } from "./preview";
import { findLoop } from "./rule-graph";
import { checkRule, companyRuleSet, ruleSetOf } from "./rule-set";
import { companyRulesSchema, type CompanyRule } from "./schema/company";
import type { CapabilityFile } from "./schema/file";
import { forgetSetup } from "./setup-cache";
import { currentTime } from "./clock";
import type { Tx } from "./tx";

// Company rules (0.2): one policy for the whole company, applied to several capabilities' sheets. Saved as one
// versioned list, like a capability's file: admins only, every part checked against its capability, no loop
// through any rule, a rule.saved entry in the Audit log for each part added, changed or removed. The kernel then
// runs each part like that capability's own rules (rule-set.ts). Changed only here, never from a capability.

// The current company rules, for admins.
export async function companyRules(tx: Tx, ctx: KernelCtx): Promise<{ version: number; rules: CompanyRule[] }> {
  await mustBeAdmin(tx, ctx);
  const loaded = await load(tx);
  return loaded.company ?? { version: 0, rules: [] };
}

type SaveOpts = { chatId?: string | null; changeSetId?: string | null; at?: Date; why?: string };

// Every part of every rule, against the capabilities and people as they are, and the loop check over all rules.
export function problemsOf(loaded: Loaded, rules: CompanyRule[]): string[] {
  const problems: string[] = [];
  const people = new Set(loaded.people.keys());
  for (const e of companyRuleSet({ version: 0, rules })) {
    if (!loaded.files.has(e.capabilityId)) {
      problems.push(`The company rule “${e.rule.text}” names an app that doesn't exist.`);
      continue;
    }
    for (const err of checkRule(loaded.files, people, e.capabilityId, e.rule)) problems.push(`The company rule “${e.rule.text}”: ${err}`);
  }
  if (problems.length) return problems;
  const files = new Map<string, CapabilityFile>([...loaded.files].map(([id, f]) => [id, f.file]));
  const loop = findLoop(files, [...ruleSetOf(files), ...companyRuleSet({ version: 0, rules })]);
  return loop ? [loop] : [];
}

// What a new version does to each part: added, changed or removed, in its own capability.
function partChanges(before: CompanyRule[], after: CompanyRule[]) {
  const parts = (rules: CompanyRule[]) => new Map<string, { rule: CompanyRule; part: CompanyRule["applications"][number] }>(rules.flatMap((r) => r.applications.map((a) => [`${r.id}/${a.id}`, { rule: r, part: a }] as const)));
  const was = parts(before);
  const now = parts(after);
  const changed = (k: string) => !sameJson({ ...was.get(k)!.rule, applications: undefined, part: was.get(k)!.part }, { ...now.get(k)!.rule, applications: undefined, part: now.get(k)!.part });
  return [
    ...[...now].filter(([k]) => !was.has(k) || changed(k)).map(([k, v]) => ({ capabilityId: v.part.capabilityId, rule: v.rule.text, change: was.has(k) ? "changed" : "added" })),
    ...[...was].filter(([k]) => !now.has(k)).map(([, v]) => ({ capabilityId: v.part.capabilityId, rule: v.rule.text, change: "removed" })),
  ];
}

async function write(tx: Tx, ctx: KernelCtx, loaded: Loaded, rules: CompanyRule[], opts: SaveOpts): Promise<{ version: number }> {
  const version = (loaded.company?.version ?? 0) + 1;
  await tx.insert(companyRulesTable).values({ workspaceId: ctx.workspaceId, version, rules, changeSetId: opts.changeSetId ?? null, chatId: opts.chatId ?? null, createdBy: ctx.actor.id, createdAt: opts.at ?? ctx.now ?? currentTime() });
  forgetSetup();
  for (const c of partChanges(loaded.company?.rules ?? [], rules))
    await record(tx, ctx, {
      who: ctx.actor.email,
      capabilityId: c.capabilityId,
      event: "rule.saved",
      details: { company: true, companyVersion: version, rule: c.rule, change: c.change, ...(opts.why ? { why: opts.why } : {}) },
      changeSetId: opts.changeSetId ?? null,
      chatId: opts.chatId ?? null,
      at: opts.at,
    });
  return { version };
}

// Saves the whole list as the next version. Refused in plain words when a part doesn't fit its capability or a
// loop would pass through it; nothing is saved then.
export async function saveCompanyRules(tx: Tx, ctx: KernelCtx, raw: unknown, opts: SaveOpts = {}): Promise<{ version: number }> {
  await mustBeAdmin(tx, ctx);
  const parsed = companyRulesSchema.safeParse(raw);
  if (!parsed.success) throw new KernelError(`The company rules aren't valid: ${parsed.error.issues[0]?.message}`, parsed.error.issues.map((i) => i.message));
  const loaded = await load(tx);
  const problems = problemsOf(loaded, parsed.data);
  if (problems.length) throw new KernelError(problems[0]!, problems);
  return write(tx, ctx, loaded, parsed.data, opts);
}

// A capability is being deleted: the parts of company rules on it, or handing work into it, stop (a rule left
// with no part goes). Called inside the delete's transaction, by whoever may delete it; nothing when none apply.
export async function dropCompanyRulesFor(tx: Tx, ctx: KernelCtx, capabilityId: string, why: string, at?: Date): Promise<void> {
  const loaded = await load(tx);
  if (!loaded.company) return;
  const touches = (a: CompanyRule["applications"][number]) => a.capabilityId === capabilityId || a.actions.some((x) => "target" in x && x.target.capability === capabilityId);
  const rules = loaded.company.rules.map((r) => ({ ...r, applications: r.applications.filter((a) => !touches(a)) })).filter((r) => r.applications.length);
  if (sameJson(rules, loaded.company.rules)) return;
  await write(tx, ctx, loaded, rules, { why, at });
}

// What a set of company rules would do, without saving it (the Company rules tab's preview): the problems, each
// part of the rule being written with its last 90 days, and warnings in plain words: someone asked to act, or
// told, who can't see the sheet, so the row can't reach their Waiting on me (or the email can't open it).
export type CompanyPreview = {
  problems: string[];
  parts: { capabilityId: string; capability: string; sheet: string; when: string; preview: Preview }[];
  warnings: string[];
};

export async function previewCompanyRules(tx: Tx, ctx: KernelCtx, raw: unknown, ruleId: string | null): Promise<CompanyPreview> {
  await mustBeAdmin(tx, ctx);
  const parsed = companyRulesSchema.safeParse(raw);
  if (!parsed.success) return { problems: parsed.error.issues.map((i) => i.message), parts: [], warnings: [] };
  const w = await startWork(tx, ctx);
  const problems = problemsOf(w.loaded, parsed.data);
  if (problems.length) return { problems, parts: [], warnings: [] };
  const parts: CompanyPreview["parts"] = [];
  const warnings: string[] = [];
  for (const e of companyRuleSet({ version: 0, rules: parsed.data }).filter((x) => x.source.kind === "company" && x.source.ruleId === ruleId)) {
    const cap = w.loaded.files.get(e.capabilityId)!;
    const sheet = cap.file.sheets.find((s) => s.id === e.rule.trigger.sheet)!;
    const part = parsed.data.find((r) => r.id === ruleId)!.applications.find((a) => a.id === e.rule.id)!;
    parts.push({ capabilityId: cap.id, capability: cap.file.name, sheet: sheet.name, when: whenOf(part, sheet.name), preview: await previewOn(w, cap.id, e.rule) });
    const rowsWord = sheet.row?.many ?? "rows";
    for (const a of e.rule.actions) {
      const named = a.kind === "ask_person" && a.person ? [a.person] : a.kind === "notify" ? (a.people ?? []) : [];
      for (const personId of named) {
        if ((await accessTo(tx, w.loaded, cap.id, personId))?.can("see", sheet.id)) continue;
        const who = w.loaded.people.get(personId)?.name.split(" ")[0] ?? "Someone";
        warnings.push(
          a.kind === "ask_person"
            ? `${who} can't see ${cap.file.name}, so the ${rowsWord} that wait on them won't show in their Waiting on me. Add them to a role there first, or ask someone who can see them.`
            : `${who} can't see ${cap.file.name}, so the email about these ${rowsWord} won't open them. Add them to a role there first.`,
        );
      }
    }
  }
  await record(tx, ctx, { who: ctx.actor.email, event: "company_rules.preview", details: { rule: parsed.data.find((r) => r.id === ruleId)?.text ?? null, parts: parts.length } });
  return { problems: [], parts, warnings: [...new Set(warnings)] };
}

// "An expense over $10,000 is added": the part's own trigger, in plain words, for the Applies to table.
function whenOf(part: CompanyRule["applications"][number], sheet: string): string {
  const t = part.trigger;
  const what = t.kind === "row_created" ? "is added" : t.kind === "enters_step" ? `reaches ${t.step}` : t.kind === "field_changed" ? `changes its ${t.field}` : "has a date come";
  return `A row in ${sheet} ${what}${part.condition ? ", when its condition holds" : ""}`;
}
