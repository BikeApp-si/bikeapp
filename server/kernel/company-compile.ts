import type { CompanyRuleOutput } from "@/server/ai/prompts/company-rule-writer@4";
import { compileRule } from "./plans/compile";
import { newId, type World } from "./plans/names";
import type { Application, CompanyRule } from "./schema/company";
import type { CapabilityFile } from "./schema/file";

// The company rule writer's answer (written by name) → the company's rules as they would be (by id), with the
// problems in plain words. Each part compiles as any rule does (plans/compile.ts): a name that doesn't exist is
// refused, money is in cents, people are ids. Ids stay put: a changed rule keeps its id, and a part keeps the id
// of its capability and sheet, so what a part already ran for (rule_runs) still counts.

// readings: each part's own plain When ("An expense over $10,000 is added"), by part id, for the Applies to table.
export type CompiledCompany = { rules: CompanyRule[]; changed: CompanyRule | null; removed: CompanyRule | null; readings: Record<string, string>; problems: string[] };

export function compileCompanyRules(out: CompanyRuleOutput, files: ReadonlyMap<string, CapabilityFile>, people: ReadonlyMap<string, string>, current: CompanyRule[]): CompiledCompany {
  const problems: string[] = [];
  const existing = out.rule_id ? current.find((r) => r.id === out.rule_id) : undefined;
  if ((out.type === "change" || out.type === "remove") && !existing) return { rules: current, changed: null, removed: null, readings: {}, problems: [`There is no company rule with the id “${out.rule_id}”.`] };
  if (out.type === "remove") return { rules: current.filter((r) => r.id !== existing!.id), changed: null, removed: existing!, readings: {}, problems };
  if (out.type !== "add" && out.type !== "change") return { rules: current, changed: null, removed: null, readings: {}, problems };
  if (!out.text || !out.when || !out.then) problems.push("A company rule needs its sentence, and a When and Then.");
  if (!out.parts.length) problems.push("A company rule needs at least one place it applies.");

  // A world with no new capability: every part is on a capability that exists.
  const world: World = { newId: "", newName: "\u0000", files, people };
  const taken = new Set<string>();
  const parts: Application[] = [];
  const readings: Record<string, string> = {};
  for (const d of out.parts) {
    const compiled = compileRule(d, world, new Set(), problems);
    if (!compiled) continue;
    const cap = files.get(compiled.capId)!;
    const sheet = cap.sheets.find((s) => s.id === compiled.rule.trigger.sheet)!;
    const before = existing?.applications.find((a) => a.capabilityId === compiled.capId && a.trigger.sheet === sheet.id);
    const id = before?.id ?? newId(`${cap.name} ${sheet.name}`, taken);
    taken.add(id);
    readings[id] = d.when.trim();
    const { trigger, condition, actions } = compiled.rule;
    parts.push({ id, capabilityId: compiled.capId, trigger, ...(condition !== undefined ? { condition } : {}), actions });
  }
  if (problems.length) return { rules: current, changed: null, removed: null, readings: {}, problems };
  const rule: CompanyRule = {
    id: existing?.id ?? newId(out.text!, new Set(current.map((r) => r.id))),
    text: out.text!.trim(),
    reading: { when: out.when!.trim(), then: out.then!.trim() },
    enabled: true,
    applications: parts,
  };
  const rules = existing ? current.map((r) => (r.id === existing.id ? rule : r)) : [...current, rule];
  return { rules, changed: rule, removed: null, readings, problems };
}
