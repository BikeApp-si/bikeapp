import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { people } from "@/db/schema";
import { accessTo } from "./access";
import { AccessError, load, type KernelCtx } from "./context";
import type { Role, Sheet, Step } from "./schema/file";
import type { Tx } from "./tx";
import { roleViewFor, rowWords } from "./views";

// What one person can do in one capability (0.4, M24; the brief's effective-access call, built early): the sheets
// they see and whose rows, what they add, edit or delete, the steps they move rows out of and into, their role
// view's line, and the rules that wait on or tell them. Only what their access gives. The tutorial is written from
// this alone, and checked against it. It names no one, so everyone with the same access shares it (and its hash).

export type SheetSummary = {
  name: string;
  one: string;
  many: string;
  sees: "all" | "own" | "team";
  add: string | null; // its add action ("Add an expense") when they may add
  edit: boolean;
  delete: boolean;
  // A ledger (M29): its entries are only added, never changed or deleted; a wrong one is reversed by whoever may add.
  // Left out for every other sheet, so their summaries (and tutorials) stay as they were.
  reverse?: boolean;
  // A dated sheet (M30): values kept by the date each starts. One in force is never changed or deleted; edit and delete
  // reach only the ones still to come. Left out for every other sheet.
  dated?: true;
  steps: string[]; // in order
  movesFrom: string[]; // the steps they may move a row out of
  movesTo: string[]; // the steps a row can reach from those
  stepRules: string[]; // "Approved: not on their own expense"
  columns: string[];
};

export type AccessSummary = {
  capability: string;
  admin: boolean;
  view: string | null; // their role view's line ("Your expenses")
  sheets: SheetSummary[];
  rules: string[]; // the sentences of rules that wait on or tell them
};

const SEES = { all: 3, team: 2, own: 1 } as const;

export async function accessSummary(tx: Tx, ctx: KernelCtx, capId: string): Promise<AccessSummary> {
  const loaded = await load(tx);
  const access = await accessTo(tx, loaded, capId, ctx.actor.id);
  const seen = access?.cap.file.sheets.filter((s) => s.kind !== "lines" && access.can("see", s.id)) ?? [];
  if (!access || !seen.length) throw new AccessError("That app doesn't exist, or you can't see it.");
  const file = access.cap.file;
  const [me] = await tx.select({ isAdmin: people.isAdmin }).from(people).where(eq(people.id, ctx.actor.id));
  const covering = (r: Role, s: Sheet) => !r.sheets || r.sheets.includes(s.id);

  const sheets = seen.map((s): SheetSummary => {
    const mine = access.roles.filter((r) => covering(r, s) && r.can.includes("see"));
    const widest = mine.reduce<"all" | "own" | "team">((w, r) => (SEES[r.scope] > SEES[w] ? r.scope : w), "own");
    const steps = s.steps ?? [];
    const movers = access.roles.filter((r) => covering(r, s) && r.can.includes("move_steps"));
    const from = movers.length ? steps.filter((st) => !st.end && movers.some((r) => !r.moveFrom || r.moveFrom.includes(st.id))) : [];
    return {
      name: s.name,
      ...words(s),
      sees: widest,
      add: access.can("add", s.id) ? (s.addAction ?? `Add ${rowWords(s).row.one}`) : null,
      edit: s.kind !== "ledger" && access.can("edit", s.id),
      delete: s.kind !== "ledger" && access.can("delete", s.id),
      ...(s.kind === "ledger" ? { reverse: access.can("add", s.id) } : {}),
      ...(s.kind === "dated" ? { dated: true as const } : {}),
      steps: steps.map((st) => st.name),
      movesFrom: from.map((st) => st.name),
      movesTo: reachable(steps, from).map((st) => st.name),
      stepRules: steps.flatMap((st) => stepRule(st, rowWords(s).row.one)),
      columns: s.columns.filter((c) => !c.hintFor && c.type !== "step").map((c) => c.name),
    };
  });

  // Rules on what they see that ask or tell a named person (them), whoever a person column names (they may be), or
  // someone's manager (they may be).
  const sheetIds = new Set(seen.map((s) => s.id));
  const rules = file.rules
    .filter((r) => r.enabled !== false && sheetIds.has(r.trigger.sheet))
    .filter((r) =>
      r.actions.some(
        (a) =>
          (a.kind === "ask_person" && (a.person ? a.person === ctx.actor.id : true)) ||
          (a.kind === "notify" && ((a.people ?? []).includes(ctx.actor.id) || (a.columns ?? []).length > 0)),
      ),
    )
    .map((r) => r.text);

  // The role view this person actually gets (none for an admin, or for someone whose widest role has none).
  const view = (await roleViewFor(tx, ctx, capId, !!me?.isAdmin))?.line ?? null;
  return { capability: file.name, admin: !!me?.isAdmin, view, sheets, rules };
}

// The same access, the same hash: the tutorial's key with the capability's version.
export const summaryHash = (s: AccessSummary) => createHash("sha256").update(JSON.stringify(s)).digest("hex").slice(0, 32);

const words = (s: Sheet) => {
  const { row } = rowWords(s);
  return { one: row.one, many: row.many };
};

// From the steps they move out of: the next step on the way, the one before, and every exit.
function reachable(steps: Step[], from: Step[]): Step[] {
  const out = new Set<Step>();
  for (const f of from) {
    const at = steps.indexOf(f);
    const next = steps.slice(at + 1).find((s) => s.end !== "exit");
    const back = steps.slice(0, at).reverse().find((s) => s.end !== "exit");
    for (const s of [next, back, ...steps.filter((s) => s.end === "exit" && s !== f)]) if (s) out.add(s);
  }
  return steps.filter((s) => out.has(s));
}

function stepRule(st: Step, one: string): string[] {
  const out: string[] = [];
  if (st.moveIn === "not_submitter") out.push(`${st.name}: not by the person who submitted the ${one}`);
  if (st.moveOut === "submitter") out.push(`Out of ${st.name}: only by the person who submitted the ${one}`);
  return out;
}
