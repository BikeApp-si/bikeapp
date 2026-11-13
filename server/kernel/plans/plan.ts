import { findLoop } from "../rule-graph";
import { ruleSetOf, type RuleEntry } from "../rule-set";
import type { CapabilityFile } from "../schema/file";
import { validateFile } from "../schema/validate";
import { applyEdits, compileCapability, compileRule, notAdditive } from "./compile";
import type { DraftAlsoChange, DraftCapability, DraftRule } from "./draft";
import { capabilityId, type World } from "./names";

// A whole plan, checked as the kernel would check it on Create, but in memory: the new capability's file,
// each existing file its Also changes add to, and the rules (each in the capability its trigger is on).
// A plan with problems is never shown; the AI gets them for its one retry.

// A restructure Bike can do (M27): a typed column turned into a link. Any other is only named.
export const canMove = (a: DraftAlsoChange) => a.kind === "restructure" && a.edits.some((e) => e.kind === "link_column");

export type PlanInput = { capability: DraftCapability; rules: DraftRule[]; alsoChanges: DraftAlsoChange[] };

export type CheckedPlan = {
  file: CapabilityFile;
  // Existing capabilities the plan adds to, by id: their file now and after.
  edited: Map<string, { before: CapabilityFile; after: CapabilityFile }>;
  // Data moves Bike can't do yet (a restructure the AI named with no edits): named, never applied.
  restructures: DraftAlsoChange[];
  problems: string[];
};

export function checkPlan(input: PlanInput, ctx: { newId: string; files: ReadonlyMap<string, CapabilityFile>; people: ReadonlyMap<string, string>; companyRules?: readonly RuleEntry[] }): CheckedPlan {
  const problems: string[] = [];
  const base: World = { newId: ctx.newId, newName: input.capability.name, files: ctx.files, people: ctx.people };
  if ([...ctx.files.values()].some((f) => f.name.trim().toLowerCase() === input.capability.name.trim().toLowerCase()))
    problems.push(`There is already an app called ${input.capability.name}.`);

  // Two passes: the new capability's ids come first (names give the same ids each time), so Also changes can
  // name it (a Spent column adding up its bills); then it is compiled again against the files as the Also
  // changes leave them, so it can read what they add (a Received total on purchases). Only the second pass's
  // problems count.
  let file = compileCapability(input.capability, base, []);
  const withNew = () => new Map([...ctx.files, ...[...edited].map(([id, e]) => [id, e.after] as const), [ctx.newId, file]]);

  const edited = new Map<string, { before: CapabilityFile; after: CapabilityFile }>();
  const restructures: DraftAlsoChange[] = [];
  for (const change of input.alsoChanges) {
    if (change.kind === "restructure" && !canMove(change)) {
      restructures.push(change);
      continue;
    }
    const id = capabilityId(base, change.capability, ctx.newId);
    const before = id ? ctx.files.get(id) : undefined;
    if (!id || !before) {
      problems.push(`Also changes: there is no app called ${change.capability}.`);
      continue;
    }
    const after = applyEdits(edited.get(id)?.after ?? before, change, { ...base, files: withNew() }, id, problems);
    edited.set(id, { before, after });
  }
  file = compileCapability(input.capability, { ...base, files: new Map([...ctx.files, ...[...edited].map(([id, e]) => [id, e.after] as const)]) }, problems);

  // Rules go where their trigger sheet is, with ids unique in that file.
  const taken = new Map<string, Set<string>>();
  for (const d of input.rules) {
    const world = { ...base, files: withNew() };
    const capId = capabilityId(world, d.capability, ctx.newId);
    const ids = taken.get(capId ?? "") ?? new Set((capId && world.files.get(capId)?.rules.map((r) => r.id)) || []);
    if (capId) taken.set(capId, ids);
    const compiled = compileRule(d, world, ids, problems);
    if (!compiled) continue;
    if (compiled.capId === ctx.newId) file.rules.push(compiled.rule);
    else {
      const e = edited.get(compiled.capId) ?? { before: ctx.files.get(compiled.capId)!, after: structuredClone(ctx.files.get(compiled.capId)!) };
      e.after.rules.push(compiled.rule);
      edited.set(compiled.capId, e);
    }
  }

  // Every file as it would be saved, against the others as they would be then.
  const all = withNew();
  const people = new Set(ctx.people.values());
  const others = (self: string) => new Map([...all].filter(([id]) => id !== self));
  const fileCheck = validateFile(file, { selfId: ctx.newId, others: others(ctx.newId), people });
  if (!fileCheck.ok) problems.push(...fileCheck.errors);
  for (const [id, e] of edited) {
    const c = validateFile(e.after, { selfId: id, others: others(id), people });
    if (!c.ok) problems.push(...c.errors);
    problems.push(...notAdditive(e.before, e.after));
  }
  const loop = findLoop(all, [...ruleSetOf(all), ...(ctx.companyRules ?? [])]);
  if (loop) problems.push(loop);

  return { file, edited, restructures, problems: [...new Set(problems)] };
}
