import { rulesOn, ruleSetOf, sourceKey, type RuleEntry } from "./rule-set";
import type { CapabilityFile, Rule } from "./schema/file";
import { stepColumn } from "./steps";

// Which rule can set off which, across every capability in the workspace. A circle that passes through
// another capability is refused when a file is saved: rule A in Hiring starts a row that runs rule B in
// Onboarding, which updates the candidate and runs A again. A circle inside one capability is left to the
// 3-level limit, since a rule asking someone at the step it is already at moves nothing.

type Node = RuleEntry & { capId: string };
const key = (n: Node) => `${sourceKey(n.source)}/${n.rule.id}`;
const node = (e: RuleEntry): Node => ({ ...e, capId: e.capabilityId });

// The rules an action's write could trigger.
function setsOff(files: ReadonlyMap<string, CapabilityFile>, rules: readonly RuleEntry[], from: Node): Node[] {
  const out: Node[] = [];
  const sheetOf = (capId: string, sheetId: string) => files.get(capId)?.sheets.find((s) => s.id === sheetId);
  const on = (capId: string, sheetId: string, fits: (r: Rule) => boolean) => {
    for (const e of rulesOn(rules, capId, sheetId)) if (e.rule.enabled && fits(e.rule)) out.push(node(e));
  };
  const here = from.rule.trigger.sheet;
  for (const a of from.rule.actions) {
    switch (a.kind) {
      case "move_to_step":
        on(from.capId, here, (r) => r.trigger.kind === "enters_step" && r.trigger.step === a.step);
        break;
      case "ask_person":
        if (a.step) on(from.capId, here, (r) => r.trigger.kind === "enters_step" && r.trigger.step === a.step);
        if (a.decision) on(from.capId, here, (r) => r.trigger.kind === "field_changed" && r.trigger.field === a.decision!.column);
        break;
      case "create_row_in": {
        const capId = a.target.capability ?? from.capId;
        const start = sheetOf(capId, a.target.sheet)?.steps?.find((s) => s.start)?.id;
        on(capId, a.target.sheet, (r) => r.trigger.kind === "row_created" || (r.trigger.kind === "enters_step" && r.trigger.step === start));
        break;
      }
      case "update_row_in": {
        const capId = a.target.capability ?? from.capId;
        const target = sheetOf(capId, a.target.sheet);
        const step = target && stepColumn(target)?.id;
        const fields = Object.keys(a.map);
        on(capId, a.target.sheet, (r) => (r.trigger.kind === "field_changed" && fields.includes(r.trigger.field ?? "")) || (r.trigger.kind === "enters_step" && !!step && fields.includes(step)));
        break;
      }
      case "notify":
      case "ai_step":
        break;
    }
  }
  return out;
}

// The first circle through more than one capability, as plain words, or null. The rules are the files' own
// unless a list is given (rule-set.ts).
export function findLoop(files: ReadonlyMap<string, CapabilityFile>, rules: readonly RuleEntry[] = ruleSetOf(files)): string | null {
  const nodes = rules.filter((e) => e.rule.enabled).map(node);
  const state = new Map<string, "visiting" | "done">();
  const path: Node[] = [];
  let found: Node[] | null = null;

  const visit = (n: Node): void => {
    if (found) return;
    state.set(key(n), "visiting");
    path.push(n);
    for (const next of setsOff(files, rules, n)) {
      const s = state.get(key(next));
      if (s === "visiting") {
        const circle = path.slice(path.findIndex((p) => key(p) === key(next)));
        if (new Set(circle.map((c) => c.capId)).size > 1) {
          found = [...circle, next];
          return;
        }
      } else if (!s) visit(next);
      if (found) return;
    }
    path.pop();
    state.set(key(n), "done");
  };
  for (const n of nodes) if (!state.has(key(n))) visit(n);
  if (!found) return null;
  const words = (found as Node[]).map((n) => `“${n.rule.text.replace(/\.$/, "")}” (${files.get(n.capId)!.name})`);
  return `These rules would set each other off in a circle: ${words.join(" → ")}.`;
}
