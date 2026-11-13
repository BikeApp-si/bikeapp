import { and, asc, eq, isNull } from "drizzle-orm";
import { rows } from "@/db/schema";
import { record } from "../audit";
import { KernelError, startWork, type KernelCtx } from "../context";
import { norm } from "../plans/names";
import { flush, WRITERS } from "../rows";
import type { CapabilityFile, Sheet } from "../schema/file";
import type { Move } from "./link-instead";
import type { Tx } from "../tx";
import { isEmptyValue } from "../values";

// 0.5 (M27): a change that moves data. The one kind so far: a typed text column turned into a link to another
// sheet ("Customer" typed on each contract → a link to its row in Customers). The file change adds the link in
// the typed column's place and keeps the typed column, read only (`replacedBy`), so nothing is lost. The kernel
// then fills the link on every row by matching the typed value to the target's title. It never guesses: a value
// with no match, or with two, refuses the whole move, listed with its reason. Same rows, same result.

export type MovePlan = {
  capabilityId: string;
  capability: string; // "Customer contracts"
  sheet: string; // "Contracts"
  rowOne: string; // "contract"
  rowMany: string;
  column: string; // the link's name: "Customer"
  kept: string; // the typed column's name now: "Customer, as typed"
  target: string; // "Customers"
  targetOne: string; // "customer"
  targetMany: string;
  rows: number; // rows on the sheet
  linked: { row: string; value: string; to: string; toName: string }[];
  empty: number; // rows with nothing typed, left empty (the link isn't required)
  created: string[]; // target rows the move adds, one per name (only when the target is new)
  cantMap: { row: string; value: string; why: string }[];
};

type Files = ReadonlyMap<string, CapabilityFile>;
// Every capability before the change set and as it leaves them. A target sheet that is new in it (Customers,
// created in the same plan) is empty, so the move adds one row per name; otherwise it only links to rows there.
export type World = { before: Files; after: Files };

const labels = (s: Sheet) => ({ one: s.row?.one ?? "row", many: s.row?.many ?? "rows" });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const live = (tx: Tx, capId: string, sheetId: string) =>
  tx
    .select({ id: rows.id, data: rows.data })
    .from(rows)
    .where(and(eq(rows.capabilityId, capId), eq(rows.sheetId, sheetId), isNull(rows.deletedAt)))
    .orderBy(asc(rows.seq));

// Read only: what the move would do to today's rows.
export async function planMove(tx: Tx, world: World, m: Move): Promise<MovePlan> {
  const files = world.after;
  const file = files.get(m.capabilityId)!;
  const sheet = file.sheets.find((s) => s.id === m.sheet)!;
  const from = sheet.columns.find((c) => c.id === m.from)!;
  const to = sheet.columns.find((c) => c.id === m.to)!;
  const targetCap = to.link!.capability ?? m.capabilityId;
  const targetFile = files.get(targetCap)!;
  const target = targetFile.sheets.find((s) => s.id === to.link!.sheet)!;
  const titleCol = target.columns.find((c) => c.id === target.titleColumn)!;
  const tl = labels(target);
  const createMissing = !world.before.get(targetCap)?.sheets.some((s) => s.id === target.id);
  const out: MovePlan = {
    capabilityId: m.capabilityId,
    capability: file.name,
    sheet: sheet.name,
    rowOne: labels(sheet).one,
    rowMany: labels(sheet).many,
    column: to.name,
    kept: from.name,
    target: target.name,
    targetOne: tl.one,
    targetMany: tl.many,
    rows: 0,
    linked: [],
    empty: 0,
    created: [],
    cantMap: [],
  };
  const typed = titleCol.type === "text" || titleCol.type === "email";
  const blocked = typed ? target.columns.find((c) => c.id !== titleCol.id && c.required && !c.default && c.type !== "step") : undefined;

  // The target's rows by name; a name two rows share points nowhere.
  const byName = new Map<string, { id: string; name: string }[]>();
  if (typed)
    for (const r of await live(tx, targetCap, target.id)) {
      const v = (r.data as Record<string, unknown>)[titleCol.id];
      if (typeof v !== "string" || isEmptyValue(v)) continue;
      const k = norm(v);
      byName.set(k, [...(byName.get(k) ?? []), { id: r.id, name: v.trim() }]);
    }

  const titleOf = (data: Record<string, unknown>) => {
    const t = data[sheet.titleColumn === to.id ? from.id : sheet.titleColumn];
    return typeof t === "string" && t.trim() ? t.trim() : `${out.rowOne} ${out.rows}`;
  };
  for (const r of await live(tx, m.capabilityId, sheet.id)) {
    out.rows++;
    const data = r.data as Record<string, unknown>;
    const v = typeof data[from.id] === "string" ? (data[from.id] as string).trim() : "";
    const row = titleOf(data);
    if (!v) {
      if (to.required) out.cantMap.push({ row, value: "", why: `No ${tl.one} is typed.` });
      else out.empty++;
      continue;
    }
    if (!typed) {
      out.cantMap.push({ row, value: v, why: `${target.name} rows aren't named by typed text, so they can't be matched.` });
      continue;
    }
    const found = byName.get(norm(v)) ?? [];
    if (found.length > 1) out.cantMap.push({ row, value: v, why: `${found.length} ${tl.many} are called “${v}”.` });
    else if (found.length === 1) out.linked.push({ row: r.id, value: v, to: found[0]!.id, toName: found[0]!.name });
    else if (!createMissing) out.cantMap.push({ row, value: v, why: `No ${tl.one} is called “${v}”.` });
    else if (blocked) out.cantMap.push({ row, value: v, why: `A new ${tl.one} needs ${blocked.name}, so it can't be made from a name alone.` });
    else {
      // A new row for this name, the first spelling found; later rows with the same name link to it.
      const made = { id: "", name: v };
      byName.set(norm(v), [made]);
      out.created.push(v);
      out.linked.push({ row: r.id, value: v, to: "", toName: v });
    }
  }
  return out;
}

// The plan's one-line reason when it can't run, for the refusal.
export function cantMapText(p: MovePlan): string {
  const n = p.cantMap.length;
  return `${plural(n, p.rowOne, p.rowMany)} can't be linked to ${p.target}, so nothing was moved. ${p.capability} keeps ${p.column} as typed.`;
}

// Inside the change set's transaction, after the new versions are saved: each move planned again on the rows as
// they are now, refused if any row can't be mapped, then the target rows it may add and the links filled.
// One `changeset.moved` entry per move, listing the rows, so each row's History shows it.
export async function applyMoves(tx: Tx, ctx: KernelCtx, world: World, moves: Move[], opts: { changeSetId: string; chatId?: string | null; at: Date }) {
  const files = world.after;
  const done: MovePlan[] = [];
  for (const m of moves) {
    const to = files.get(m.capabilityId)!.sheets.find((s) => s.id === m.sheet)!.columns.find((c) => c.id === m.to)!;
    const targetCap = to.link!.capability ?? m.capabilityId;
    const p = await planMove(tx, world, m);
    if (p.cantMap.length) throw new KernelError(cantMapText(p), p.cantMap.map((c) => `${c.row}: ${c.why}`));
    const w = await startWork(tx, { ...ctx, now: opts.at });
    const target = files.get(targetCap)!.sheets.find((s) => s.id === to.link!.sheet)!;
    // Only an admin runs a move (Apply checks it), on every row, so the rows' own roles don't stop it.
    const made = new Map<string, string>();
    for (const name of p.created) {
      const r = await WRITERS.create(w, targetCap, target.id, { values: { [target.titleColumn]: name } }, { audit: false, asImport: true, asRule: true, quiet: true, history: true });
      made.set(norm(name), r.id);
    }
    for (const l of p.linked) {
      const id = l.to || made.get(norm(l.value))!;
      await WRITERS.update(w, l.row, { [m.to]: id }, { audit: false, quiet: true, asRule: true });
    }
    await record(tx, ctx, {
      who: ctx.actor.email,
      capabilityId: m.capabilityId,
      event: "changeset.moved",
      details: {
        sheet: p.sheet,
        change: `${p.kept} → ${p.column}, linked to ${p.target}`,
        linked: p.linked.length,
        ...(p.created.length ? { added: p.created.length } : {}),
        ...(p.empty ? { "left empty": p.empty } : {}),
      },
      changeSetId: opts.changeSetId,
      chatId: opts.chatId ?? null,
      at: opts.at,
      rows: p.linked.map((l) => l.row),
    });
    await flush(w);
    done.push(p);
  }
  return done;
}
