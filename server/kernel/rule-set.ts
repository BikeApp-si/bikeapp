import type { CapabilityFile, Rule } from "./schema/file";
import type { CompanyRule } from "./schema/company";
import { validateFile } from "./schema/validate";

// The rules the kernel runs, as one list. Each rule says where it came from (its source) and which
// capability its trigger sheet is in. A capability's own rules come from its file; a company rule (0.2) adds one
// entry per capability it applies to, after that capability's own. The engine, the daily job, waits, the loop
// check and the preview read this list, never a file's rules directly.

export type RuleSource = { kind: "capability"; capabilityId: string; version: number } | { kind: "company"; ruleId: string; version: number };
export type RuleEntry = { source: RuleSource; capabilityId: string; rule: Rule };

// How a source is stored on waits and rule runs. With the rule's id it names one rule: a capability's rule ids
// are unique in its file, and a company rule's parts are unique within it.
export const sourceKey = (s: RuleSource): string => (s.kind === "capability" ? `capability:${s.capabilityId}` : `company:${s.ruleId}`);

// A company rule's parts, as the rules the kernel runs: each on its own capability, with the company rule's words.
export function companyRuleSet(company: { version: number; rules: CompanyRule[] } | null): RuleEntry[] {
  if (!company) return [];
  return company.rules.flatMap((cr) =>
    cr.applications.map((a) => ({
      source: { kind: "company" as const, ruleId: cr.id, version: company.version },
      capabilityId: a.capabilityId,
      rule: { id: a.id, text: cr.text, reading: cr.reading, trigger: a.trigger, ...(a.condition !== undefined ? { condition: a.condition } : {}), actions: a.actions, enabled: cr.enabled },
    })),
  );
}

// Only the company's entries of a rule list (the checks add them to files that are being changed).
export const companyEntries = (rules: readonly RuleEntry[]): RuleEntry[] => rules.filter((e) => e.source.kind === "company");

type FileAt = { version: number; file: CapabilityFile };

// Every rule in these files, capability by capability, each in its file's order. A file with no rules list
// (never saved through the kernel) has none.
export function ruleSet(files: ReadonlyMap<string, FileAt>): RuleEntry[] {
  return [...files].flatMap(([capabilityId, f]) =>
    (f.file.rules ?? []).map((rule) => ({ source: { kind: "capability" as const, capabilityId, version: f.version }, capabilityId, rule })),
  );
}

// The same, for files that have no version yet (a file being checked before it is saved).
export const ruleSetOf = (files: ReadonlyMap<string, CapabilityFile>): RuleEntry[] =>
  ruleSet(new Map([...files].map(([id, file]) => [id, { version: 0, file }])));

// The rules whose trigger is on this sheet, in list order.
export const rulesOn = (rules: readonly RuleEntry[], capabilityId: string, sheetId: string): RuleEntry[] =>
  rules.filter((e) => e.capabilityId === capabilityId && e.rule.trigger.sheet === sheetId);

// The rules of one capability, in list order.
export const rulesOf = (rules: readonly RuleEntry[], capabilityId: string): RuleEntry[] => rules.filter((e) => e.capabilityId === capabilityId);

// One rule, by the source key stored with a wait or a run and its id.
export const findRule = (rules: readonly RuleEntry[], key: string, ruleId: string): RuleEntry | undefined =>
  rules.find((e) => sourceKey(e.source) === key && e.rule.id === ruleId);

// Checks one rule against the capability its trigger is on, whatever its source: the sheets, steps, columns
// and people it names, as a file save would. Plain-words errors, or none.
export function checkRule(
  files: ReadonlyMap<string, { file: CapabilityFile }>,
  people: ReadonlySet<string>,
  capabilityId: string,
  rule: Rule,
): string[] {
  const home = files.get(capabilityId);
  if (!home) return ["That app doesn't exist."];
  const others = new Map([...files].filter(([id]) => id !== capabilityId).map(([id, f]) => [id, f.file]));
  const checked = validateFile({ ...home.file, rules: [rule] }, { selfId: capabilityId, others, people });
  return checked.ok ? [] : checked.errors;
}
