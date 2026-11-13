import { evaluate } from "./expr/evaluate";
import type { Mover, Sheet, Step } from "./schema/file";

// How a row moves through its sheet's steps:
// - forward to the next step,
// - back one step,
// - or to an exit step (Declined, Rejected) from anywhere.
// A final step (Taken, Paid) is reached only by moving forward. A step with a condition (Legal review, for
// contracts over $50,000) is part of the way only when its condition holds, so it can't be skipped then.

export function stepColumn(sheet: Sheet) {
  return sheet.columns.find((c) => c.type === "step");
}

// Whose a row is, for step settings: the person column that defaults to whoever adds it (Who, Requested by),
// or whoever added it.
export function submitterOf(sheet: Sheet, data: Record<string, unknown>, createdBy: string | null): string | null {
  const col = sheet.columns.find((c) => c.type === "person" && c.default?.kind === "creator");
  const v = col ? data[col.id] : createdBy;
  return typeof v === "string" ? v : null;
}

// A step's own say over who moves rows out of it and into it (on top of the person's role). The kernel reads
// these settings from the file and knows nothing about what a step is called.
export function stepAllows(from: Step | undefined, to: Step, submitter: string | null, actorId: string): { ok: true } | { ok: false; side: "out" | "in" } {
  const fits = (rule: Mover | undefined) =>
    !rule || rule === "anyone" || (rule === "submitter" ? submitter === actorId : submitter !== actorId);
  if (!fits(from?.moveOut)) return { ok: false, side: "out" };
  if (!fits(to.moveIn)) return { ok: false, side: "in" };
  return { ok: true };
}

export function allowedMoves(sheet: Sheet, data: Record<string, unknown>, today: string): Step[] {
  const steps = sheet.steps ?? [];
  const col = stepColumn(sheet);
  const at = steps.findIndex((s) => s.id === data[col?.id ?? ""]);
  if (at < 0) return [];
  const onTheWay = (s: Step) => s.end !== "exit" && (!s.onlyWhen || evaluate(s.onlyWhen, { value: (c) => data[c], today }) === true);

  const next = steps.slice(at + 1).find(onTheWay);
  const back = steps.slice(0, at).reverse().find(onTheWay);
  const exits = steps.filter((s, i) => s.end === "exit" && i !== at);
  const moves = [next, back, ...exits].filter((s): s is Step => !!s);
  return steps.filter((s) => moves.includes(s)); // in flow order, once each
}
