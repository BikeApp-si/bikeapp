import { isCol, isOp, isSumOf, walk, type Expr } from "../expr/ast";
import type { CapabilityFile, Rule } from "../schema/file";
import { stepColumn } from "../steps";
import type { World } from "./check";

// The dependency check (6h): every rule and connection, in any capability, that reads a step or column. A
// Customize change that renames or adds a condition to one lists them, with the fix prompt 4 writes; Apply
// saves the fixes in the same change set. Ids never change, so a rename breaks nothing; the sentences that
// name the old name are what the fix rewrites.

export type Use = {
  capabilityId: string;
  kind: "connection" | "rule" | "total";
  ruleId?: string;
  text: string; // the rule's sentence, or the total ("Budgets › Spent")
};

export type Target = { capabilityId: string; sheetId: string } & ({ step: string } | { column: string });

const exprs = (rule: Rule): Expr[] => [
  ...(rule.condition !== undefined ? [rule.condition] : []),
  ...rule.actions.flatMap((a) => ("map" in a ? Object.values(a.map) : [])),
];

// Whether a rule on `sheet` (in `capId`) reads the target.
export function ruleReads(rule: Rule, capId: string, t: Target, world: World): boolean {
  const here = capId === t.capabilityId && rule.trigger.sheet === t.sheetId;
  const target = world.get(t.capabilityId)?.sheets.find((s) => s.id === t.sheetId);
  if ("step" in t) {
    const stepCol = target && stepColumn(target)?.id;
    if (here && rule.trigger.step === t.step) return true;
    for (const a of rule.actions) {
      if (here && (a.kind === "move_to_step" || a.kind === "ask_person") && a.step === t.step) return true;
      // A field map that moves the target's rows to the step (Hired → the opening moves to Filled).
      if ((a.kind === "create_row_in" || a.kind === "update_row_in") && (a.target.capability ?? capId) === t.capabilityId && a.target.sheet === t.sheetId && stepCol && a.map[stepCol] === t.step) return true;
    }
    // A condition that compares the step column with the step ("while it is in Renewal due").
    return here && !!stepCol && exprs(rule).some((e) => [...walk(e)].some((n) => isOp(n) && n.args.some((x) => isCol(x) && x.col === stepCol && !x.via) && n.args.includes(t.step)));
  }
  const col = t.column;
  if (here && (rule.trigger.field === col || rule.trigger.date === col)) return true;
  if (here && exprs(rule).some((e) => [...walk(e)].some((n) => isCol(n) && (n.col === col || n.via === col)))) return true;
  for (const a of rule.actions) {
    if (here && a.kind === "ask_person" && [a.column, a.until, a.via, a.managerOf, a.decision?.column].includes(col)) return true;
    if (here && a.kind === "notify" && a.columns?.includes(col)) return true;
    if (here && a.kind === "update_row_in" && a.via === col) return true;
    if ((a.kind === "create_row_in" || a.kind === "update_row_in") && (a.target.capability ?? capId) === t.capabilityId && a.target.sheet === t.sheetId && col in a.map) return true;
  }
  return false;
}

const writesElsewhere = (rule: Rule, capId: string) => rule.actions.some((a) => "target" in a && !!a.target.capability && a.target.capability !== capId);

export function usesOf(world: World, t: Target): Use[] {
  const out: Use[] = [];
  for (const [capId, file] of world) {
    for (const rule of file.rules) {
      if (!ruleReads(rule, capId, t, world)) continue;
      out.push({ capabilityId: capId, kind: capId !== t.capabilityId || writesElsewhere(rule, capId) ? "connection" : "rule", ruleId: rule.id, text: rule.text });
    }
    out.push(...totalsReading(file, capId, t));
  }
  return out;
}

// Totals that add up the target's rows at a step, or add up the target column (Spent: Amount of Paid bills).
function totalsReading(file: CapabilityFile, capId: string, t: Target): Use[] {
  const out: Use[] = [];
  for (const s of file.sheets)
    for (const c of s.columns) {
      if (c.type !== "computed" || c.expr === undefined) continue;
      const hit = [...walk(c.expr)].some((n) => {
        if (!isSumOf(n) || (n.sumOf.capability ?? capId) !== t.capabilityId || n.sumOf.sheet !== t.sheetId) return false;
        return "step" in t ? !!n.sumOf.steps?.includes(t.step) : n.sumOf.column === t.column || n.sumOf.by === t.column;
      });
      if (hit) out.push({ capabilityId: capId, kind: "total", text: `${file.name} › ${s.name} › ${c.name}` });
    }
  return out;
}
