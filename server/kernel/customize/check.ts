import { notAdditive } from "../plans/compile";
import { findLoop } from "../rule-graph";
import { checkRule, ruleSetOf, type RuleEntry } from "../rule-set";
import type { CapabilityFile } from "../schema/file";
import { validateFile } from "../schema/validate";

// The kernel's checks on a Customize change set, before it is previewed and again on Apply. Every file is
// checked as the whole change set leaves the workspace, so a connection left pointing at something that no
// longer exists is caught in the capability it starts from. Plain words, so the reply can show them.

export type World = ReadonlyMap<string, CapabilityFile>;
// Rows at each step, by "capability/sheet/step", for refusing a step removal in plain words.
export type StepCounts = ReadonlyMap<string, number>;

export const stepKey = (capId: string, sheetId: string, stepId: string) => `${capId}/${sheetId}/${stepId}`;

// company: the company's rules (0.2): a change may not break a part of one, nor close a loop through one.
export function checkCustomize(before: World, edits: ReadonlyMap<string, CapabilityFile>, people: ReadonlySet<string>, counts: StepCounts, company: readonly RuleEntry[] = []): string[] {
  const problems: string[] = [];
  const world = new Map(before);
  for (const [id, after] of edits) world.set(id, after);

  for (const [id, after] of edits) {
    const was = before.get(id);
    if (!was) {
      problems.push("That app doesn't exist.");
      continue;
    }
    // A step that holds rows can't go: its rows would have to move. Renaming it keeps them where they are.
    const lost = new Set<string>();
    for (const s of was.sheets)
      for (const st of s.steps ?? []) {
        if (after.sheets.find((x) => x.id === s.id)?.steps?.some((x) => x.id === st.id)) continue;
        const n = counts.get(stepKey(id, s.id, st.id)) ?? 0;
        const rows = s.row ?? { one: "row", many: "rows" };
        lost.add(`${s.name} would lose its ${st.name} step.`);
        problems.push(
          n
            ? `${st.name} has ${n} ${n === 1 ? rows.one : rows.many}, so it can't be removed in this version. It can be renamed instead.`
            : `${st.name} can't be removed in this version; a step can be added or renamed.`,
        );
      }
    problems.push(...notAdditive(was, after, { rulesMayChange: true }).filter((p) => !lost.has(p)));
  }

  // Every file against the others, as the change set leaves them: the changed ones and those that read them.
  for (const [id, file] of world) {
    const r = validateFile(file, { selfId: id, others: new Map([...world].filter(([o]) => o !== id)), people: new Set(people) });
    if (!r.ok) problems.push(...r.errors.map((e) => (edits.has(id) ? e : `${file.name}: ${e}`)));
  }
  // A company rule's part on a changed capability must still fit it.
  const worldFiles = new Map([...world].map(([id, file]) => [id, { file }]));
  for (const e of company)
    if (edits.has(e.capabilityId))
      for (const err of checkRule(worldFiles, people, e.capabilityId, e.rule)) problems.push(`The company rule “${e.rule.text}” would no longer work: ${err}`);
  const loop = findLoop(world, [...ruleSetOf(world), ...company]);
  if (loop) problems.push(loop);
  return [...new Set(problems)];
}
