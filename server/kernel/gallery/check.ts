import { findLoop } from "../rule-graph";
import { checkRule, companyRuleSet, ruleSetOf } from "../rule-set";
import { companyRulesSchema, type CompanyRule } from "../schema/company";
import type { CapabilityFile } from "../schema/file";
import { validateFile } from "../schema/validate";
import { referencesIn, resolve, type AppSet, type Filled } from "./format";

// The set's check (G1), run in CI over every folder in gallery/ and again before a set is added: every reference
// names an app or slot of the set, every app passes the kernel's file check with the others as they'll be, the
// company rules pass theirs, and no rule loops. Problems in plain words, the app named first.

// Stand-in ids for the check: the same every run, so the same set gives the same problems.
const stand = (n: number, kind: "a" | "p") => `00000000-0000-4000-8${kind === "a" ? "000" : "001"}-${n.toString(16).padStart(12, "0")}`;

export function placeholders(set: AppSet): Filled {
  return {
    apps: Object.fromEntries(set.apps.map((a, i) => [a, stand(i + 1, "a")])),
    slots: Object.fromEntries(set.slots.map((s, i) => [s.key, [stand(i + 1, "p")]])),
  };
}

export type SetCheck = { ok: true; files: Map<string, CapabilityFile>; companyRules: CompanyRule[] } | { ok: false; problems: string[] };

// Checks a set filled in: with stand-ins (checkSet), or with a company's own app ids and people (add.ts).
export function checkFilled(set: AppSet, filled: Filled, world: ReadonlyMap<string, CapabilityFile> = new Map(), people: ReadonlySet<string> = new Set()): SetCheck {
  const problems: string[] = [];
  const slotKeys = new Set(set.slots.map((s) => s.key));
  if (slotKeys.size !== set.slots.length) problems.push("Two role slots have the same key.");
  if (new Set(set.apps).size !== set.apps.length) problems.push("An app is listed twice.");

  const nameOf = (app: string) => {
    const n = (set.files[app] as { name?: unknown } | undefined)?.name;
    return typeof n === "string" ? n : app;
  };
  const refs = (where: string, value: unknown) => {
    const r = referencesIn(value);
    for (const a of r.apps) if (!set.apps.includes(a)) problems.push(`${where}: names an app “${a}” that isn't in the set.`);
    for (const s of r.slots) if (!slotKeys.has(s)) problems.push(`${where}: names a role slot “${s}” that the set doesn't have.`);
  };
  for (const app of set.apps) refs(nameOf(app), set.files[app]);
  refs("Company rules", set.companyRules);
  if (problems.length) return { ok: false, problems };

  const names = set.apps.map((a) => nameOf(a).trim().toLowerCase());
  for (const [i, n] of names.entries()) if (names.indexOf(n) !== i) problems.push(`Two apps are called “${nameOf(set.apps[i]!)}”.`);

  const allPeople = new Set([...people, ...Object.values(filled.slots).flat()]);
  const resolved = new Map(set.apps.map((a) => [filled.apps[a]!, resolve(set.files[a], filled)]));
  const files = new Map<string, CapabilityFile>();
  for (const app of set.apps) {
    const id = filled.apps[app]!;
    const others = new Map<string, CapabilityFile>([...world]);
    for (const [otherId, raw] of resolved) if (otherId !== id) others.set(otherId, raw as CapabilityFile);
    const r = validateFile(resolved.get(id), { selfId: id, others, people: allPeople });
    if (!r.ok) problems.push(...r.errors.map((e) => `${nameOf(app)}: ${e}`));
    else files.set(id, r.file);
  }
  if (problems.length) return { ok: false, problems };

  const parsed = companyRulesSchema.safeParse(resolve(set.companyRules, filled));
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((i) => `Company rules: ${i.message}`) };
  const all = new Map<string, CapabilityFile>([...world, ...files]);
  const wrapped = new Map([...all].map(([id, file]) => [id, { file }] as const));
  for (const e of companyRuleSet({ version: 0, rules: parsed.data })) {
    if (!all.has(e.capabilityId)) problems.push(`The company rule “${e.rule.text}” names an app that isn't in the set.`);
    else for (const err of checkRule(wrapped, allPeople, e.capabilityId, e.rule)) problems.push(`The company rule “${e.rule.text}”: ${err}`);
  }
  if (problems.length) return { ok: false, problems };
  const loop = findLoop(all, [...ruleSetOf(all), ...companyRuleSet({ version: 0, rules: parsed.data })]);
  if (loop) return { ok: false, problems: [loop] };
  return { ok: true, files, companyRules: parsed.data };
}

export function checkSet(set: AppSet): SetCheck {
  return checkFilled(set, placeholders(set));
}
