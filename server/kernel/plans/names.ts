import { isBalanceOf, isCol, isInForce, isLookup, isOp, isSumOf, type Expr } from "../expr/ast";
import type { CapabilityFile, Column, Sheet } from "../schema/file";

// Names → ids, for plans the AI writes by name. Ids are stable once given: a column keeps its id when it is
// renamed later. Names are matched without regard to case or spacing.

export const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

// "Value a year" → "value_a_year", made unique among `taken`.
export function newId(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 36) || "x";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  taken.add(id);
  return id;
}

export const byName = <T extends { name: string }>(list: readonly T[] | undefined, n: string | null | undefined): T | undefined =>
  n == null ? undefined : list?.find((x) => norm(x.name) === norm(n));

// The capabilities a plan can name: the ones that exist and the new one, by id.
export type World = {
  newId: string;
  newName: string;
  files: ReadonlyMap<string, CapabilityFile>; // includes the new one once it is compiled
  people: ReadonlyMap<string, string>; // work email (lowercase) → person id
};

export function capabilityId(world: World, capName: string | null | undefined, here: string): string | undefined {
  if (capName == null) return here;
  if (norm(capName) === norm(world.newName)) return world.newId;
  for (const [id, f] of world.files) if (norm(f.name) === norm(capName)) return id;
  return undefined;
}

export const personId = (world: World, email: string | null | undefined) => (email ? world.people.get(email.trim().toLowerCase()) : undefined);

type Scope = { world: World; capId: string; sheet: Sheet; problems: string[]; where: string };

const sheetOf = (world: World, capId: string, sheetName: string) => byName(world.files.get(capId)?.sheets, sheetName);

// A literal in the terms of the column it goes with: an option or step by its id, a person by id, money in cents.
function literal(s: Scope, col: Column | undefined, v: Expr, steps?: Sheet["steps"]): Expr {
  if (!col || v === null || typeof v === "object") return v;
  switch (col.type) {
    case "money":
      return typeof v === "number" ? Math.round(v * 100) : v;
    case "choice": {
      if (typeof v !== "string") return v;
      const o = byName(col.options, v) ?? col.options?.find((x) => x.id === v);
      if (!o) s.problems.push(`${s.where}: ${col.name} has no choice “${v}”.`);
      return o?.id ?? v;
    }
    case "step": {
      if (typeof v !== "string") return v;
      const st = byName(steps, v) ?? steps?.find((x) => x.id === v);
      if (!st) s.problems.push(`${s.where}: there is no step “${v}”.`);
      return st?.id ?? v;
    }
    case "person": {
      if (typeof v !== "string") return v;
      const id = personId(s.world, v);
      if (!id) s.problems.push(`${s.where}: ${v} isn't in People.`);
      return id ?? v;
    }
    default:
      return v;
  }
}

// The column an expression names, to read literals next to it (with the steps of its sheet, for a step column).
function columnOf(s: Scope, e: Expr | undefined): { col: Column; steps?: Sheet["steps"] } | undefined {
  if (e === undefined || !isCol(e)) return undefined;
  if (!e.via) {
    const col = s.sheet.columns.find((c) => c.id === e.col);
    return col && { col, steps: s.sheet.steps };
  }
  const link = s.sheet.columns.find((c) => c.id === e.via)?.link;
  const target = link && s.world.files.get(link.capability ?? s.capId)?.sheets.find((x) => x.id === link.sheet);
  const col = target?.columns.find((c) => c.id === e.col);
  return col && { col, steps: target?.steps };
}

const COMPARES = new Set(["eq", "ne", "in", "gt", "gte", "lt", "lte", "between", "add", "sub"]);

// An expression written by name, as the kernel's expression with ids. `like`: the column its value goes into
// (a default or a field map), so a literal there reads in that column's terms.
export function resolveExpr(text: string, s: Scope, like?: { col: Column; steps?: Sheet["steps"] }): Expr {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A bare word is a literal ("Standard").
    parsed = text;
  }
  const go = (e: Expr): Expr => {
    if (e === null || typeof e !== "object") return e;
    if (isCol(e)) {
      if (e.via) {
        const link = byName(s.sheet.columns, e.via);
        const target = link?.type === "link" && link.link ? s.world.files.get(link.link.capability ?? s.capId)?.sheets.find((x) => x.id === link.link!.sheet) : undefined;
        if (!link || !target) {
          s.problems.push(`${s.where}: “${e.via}” isn't a link column on ${s.sheet.name}.`);
          return e;
        }
        const col = byName(target.columns, e.col);
        if (!col) s.problems.push(`${s.where}: ${target.name} has no column “${e.col}”.`);
        return { col: col?.id ?? e.col, via: link.id, ...(e.part ? { part: e.part } : {}) };
      }
      const col = byName(s.sheet.columns, e.col);
      if (!col) s.problems.push(`${s.where}: ${s.sheet.name} has no column “${e.col}”.`);
      return { col: col?.id ?? e.col, ...(e.part ? { part: e.part } : {}) };
    }
    if (isSumOf(e)) {
      if (typeof e.sumOf !== "object" || e.sumOf === null || !e.sumOf.sheet || !e.sumOf.column) {
        s.problems.push(`${s.where}: a total names the sheet and the column it adds up.`);
        return e;
      }
      const capId = capabilityId(s.world, e.sumOf.capability, s.capId);
      const other = capId ? sheetOf(s.world, capId, e.sumOf.sheet) : undefined;
      if (!capId || !other) {
        s.problems.push(`${s.where}: there is no sheet “${e.sumOf.sheet}” to add up.`);
        return e;
      }
      const col = byName(other.columns, e.sumOf.column);
      const by = e.sumOf.by ? byName(other.columns, e.sumOf.by) : undefined;
      const steps = (e.sumOf.steps ?? []).map((n) => byName(other.steps, n));
      if (!col) s.problems.push(`${s.where}: ${other.name} has no column “${e.sumOf.column}”.`);
      if (e.sumOf.by && !by) s.problems.push(`${s.where}: ${other.name} has no column “${e.sumOf.by}”.`);
      steps.forEach((st, i) => !st && s.problems.push(`${s.where}: ${other.name} has no step “${e.sumOf.steps![i]}”.`));
      return {
        sumOf: {
          ...(capId !== s.capId ? { capability: capId } : {}),
          sheet: other.id,
          column: col?.id ?? e.sumOf.column,
          ...(by ? { by: by.id } : {}),
          ...(steps.length ? { steps: steps.map((st, i) => st?.id ?? e.sumOf.steps![i]!) } : {}),
        },
      };
    }
    // A value in force on a date (M30): {"inForce":{"sheet":"Spending limits","is":"Category","on":"Date","value":"Limit"}};
    // is left out for a sheet that keeps one series, on left out for today.
    if (isInForce(e)) {
      const f = typeof e.inForce === "object" && e.inForce !== null ? e.inForce : undefined;
      const dated = f ? sheetOf(s.world, s.capId, f.sheet) : undefined;
      if (!f || !dated) {
        s.problems.push(`${s.where}: there is no sheet “${String(f?.sheet ?? "")}” kept by date to read from.`);
        return e;
      }
      const own = (n: string | undefined) => {
        if (!n) return undefined;
        const c = byName(s.sheet.columns, n);
        if (!c) s.problems.push(`${s.where}: ${s.sheet.name} has no column “${n}”.`);
        return c?.id;
      };
      const value = byName(dated.columns, f.value);
      if (!value) s.problems.push(`${s.where}: ${dated.name} has no column “${f.value}”.`);
      const [is, on] = [own(f.is), own(f.on)];
      return { inForce: { sheet: dated.id, ...(is ? { is } : {}), ...(on ? { on } : {}), value: value?.id ?? f.value } };
    }
    // A ledger's balance (M29): {"balanceOf":{"sheet":"Leave entries","of":"Who"}}; of left out when the ledger's
    // account is a link to this row.
    if (isBalanceOf(e)) {
      const ledger = typeof e.balanceOf === "object" && e.balanceOf !== null ? sheetOf(s.world, s.capId, e.balanceOf.sheet) : undefined;
      if (!ledger) {
        s.problems.push(`${s.where}: there is no ledger “${String(e.balanceOf?.sheet ?? "")}” to read a balance from.`);
        return e;
      }
      const of = e.balanceOf.of ? byName(s.sheet.columns, e.balanceOf.of) : undefined;
      if (e.balanceOf.of && !of) s.problems.push(`${s.where}: ${s.sheet.name} has no column “${e.balanceOf.of}”.`);
      return { balanceOf: { sheet: ledger.id, ...(of ? { of: of.id } : {}) } };
    }
    if (isLookup(e)) {
      const other = sheetOf(s.world, s.capId, e.lookup.sheet);
      if (!other) {
        s.problems.push(`${s.where}: there is no sheet “${e.lookup.sheet}” to look in.`);
        return e;
      }
      const id = (list: Column[], n: string) => byName(list, n)?.id ?? n;
      return { lookup: { sheet: other.id, where: id(other.columns, e.lookup.where), is: id(s.sheet.columns, e.lookup.is), value: id(other.columns, e.lookup.value) } };
    }
    if (!isOp(e)) return e;
    const args = e.args.map(go);
    if (COMPARES.has(e.op)) {
      const ref = args.map((a) => columnOf(s, a)).find(Boolean);
      return { op: e.op, args: args.map((a) => (ref && !isCol(a) ? literal(s, ref.col, a, ref.steps) : a)) };
    }
    if (e.op === "if") return { op: e.op, args: [args[0]!, ...args.slice(1).map((a) => (like && !isCol(a) ? literal(s, like.col, a, like.steps) : a))] };
    return { op: e.op, args };
  };
  const out = go(parsed as Expr);
  return like && (out === null || typeof out !== "object") ? literal(s, like.col, out, like.steps) : out;
}
