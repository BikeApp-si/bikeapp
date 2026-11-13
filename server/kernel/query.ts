import { sql, type SQL } from "drizzle-orm";
import { isSumOf, usesToday, walk } from "./expr/ast";
import { KernelError } from "./context";
import { datedOf, ledgerOf, type Column, type Sheet } from "./schema/file";

// Filter and sort for a sheet's table, as SQL over a row's data under the alias "r". They run in the kernel's
// read, inside access, so they cover every matching row (not only the ones loaded) and the export.

export type Filter =
  | { column: string; op: "in"; values: string[] } // a step, choice, person or linked row
  | { column: string; op: "contains"; text: string } // text
  | { column: string; op: "between"; from?: number | string | null; to?: number | string | null }; // number, money, date
export type Sort = { column: string; dir: "asc" | "desc" };

const NUMERIC = new Set(["number", "money", "percent", "days"]);
const TEXT = new Set(["text", "long_text", "email", "phone", "url"]);
const PICKED = new Set(["step", "choice", "person", "link"]);

// A computed column that uses today is worked out when read, so the database can't filter or sort by it.
const inDatabase = (c: Column) => !(c.type === "computed" && c.expr && usesToday(c.expr));
const isNumeric = (c: Column) => NUMERIC.has(c.type) || (c.type === "computed" && c.result !== "date" && c.result !== "text");
const isDate = (c: Column) => c.type === "date" || c.type === "datetime" || (c.type === "computed" && c.result === "date");

function columnOf(sheet: Sheet, id: string): Column {
  const c = sheet.columns.find((col) => col.id === id);
  if (!c) throw new KernelError(`${sheet.name} has no such column.`);
  return c;
}

const value = (c: Column) => sql`r.data->>${c.id}`;

// What a column sorts by: numbers as numbers, steps and choices in their order, people and links by name.
function sortKey(sheet: Sheet, c: Column, titleOf: (sheetId: string, capId?: string) => string | null): SQL {
  if (isNumeric(c)) return sql`(${value(c)})::numeric`;
  if (c.type === "money_range") return sql`(r.data->${c.id}->>'from')::numeric`;
  if (c.type === "step" || c.type === "choice") {
    const ids = (c.type === "step" ? sheet.steps ?? [] : c.options ?? []).map((o) => o.id);
    return ids.length ? sql`array_position(array[${sql.join(ids.map((i) => sql`${i}`), sql`, `)}]::text[], ${value(c)})` : value(c);
  }
  if (c.type === "person") return sql`(select p.name from people p where p.id::text = ${value(c)})`;
  if (c.type === "link" && c.link) {
    const title = titleOf(c.link.sheet, c.link.capability);
    return title ? sql`(select l.data->>${title} from rows l where l.id::text = ${value(c)})` : value(c);
  }
  return sql`lower(${value(c)})`;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export function filterSql(sheet: Sheet, filters: Filter[]): SQL | undefined {
  if (!filters.length) return undefined;
  const parts = filters.map((f) => {
    const c = columnOf(sheet, f.column);
    if (!inDatabase(c)) throw new KernelError(`${c.name} changes every day, so rows can't be filtered by it.`);
    if (f.op === "in") {
      if (!PICKED.has(c.type)) throw new KernelError(`${c.name} isn't picked from a list.`);
      if (!f.values.length) return sql`false`;
      return sql`${value(c)} in (${sql.join(f.values.map((v) => sql`${v}`), sql`, `)})`;
    }
    if (f.op === "contains") {
      if (!TEXT.has(c.type)) throw new KernelError(`${c.name} isn't text.`);
      return sql`${value(c)} ilike ${`%${escapeLike(f.text.trim())}%`}`;
    }
    const num = isNumeric(c) || c.type === "money_range";
    if (!num && !isDate(c)) throw new KernelError(`${c.name} isn't a number or a date.`);
    const key = c.type === "money_range" ? sql`(r.data->${c.id}->>'from')::numeric` : num ? sql`(${value(c)})::numeric` : value(c);
    const ends = [
      f.from !== undefined && f.from !== null ? sql`${key} >= ${f.from}` : null,
      f.to !== undefined && f.to !== null ? sql`${key} <= ${f.to}` : null,
    ].filter((p): p is SQL => !!p);
    return ends.length ? sql.join(ends, sql` and `) : sql`true`;
  });
  return sql`(${sql.join(parts, sql` and `)})`;
}

// Search within a sheet (0.4, M19): a row matches when any of its text columns contains the words, or the name of its
// person, choice, step or linked row does. Case-insensitive, `%` and `_` taken as themselves.
export function searchSql(sheet: Sheet, text: string, titleOf: (sheetId: string, capId?: string) => string | null): SQL | undefined {
  const q = text.trim();
  if (!q) return undefined;
  const like = `%${escapeLike(q)}%`;
  const low = q.toLowerCase();
  const parts: SQL[] = [];
  for (const c of sheet.columns) {
    if (TEXT.has(c.type)) parts.push(sql`${value(c)} ilike ${like}`);
    else if (c.type === "person") parts.push(sql`exists (select 1 from people p where p.id::text = ${value(c)} and p.name ilike ${like})`);
    else if (c.type === "choice" || c.type === "step") {
      const ids = (c.type === "step" ? sheet.steps ?? [] : c.options ?? []).filter((o) => o.name.toLowerCase().includes(low)).map((o) => o.id);
      if (ids.length) parts.push(sql`${value(c)} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
    } else if (c.type === "link" && c.link) {
      const title = titleOf(c.link.sheet, c.link.capability);
      if (title) parts.push(sql`exists (select 1 from rows l where l.id::text = ${value(c)} and l.data->>${title} ilike ${like})`);
    }
  }
  return parts.length ? sql`(${sql.join(parts, sql` or `)})` : sql`false`;
}

// The order rows come in: the sort asked for, else the sheet's own, else the order they were written.
// Empty values go last; ties keep the order they were written in.
export function orderSql(sheet: Sheet, sort: Sort | undefined, titleOf: (sheetId: string, capId?: string) => string | null): SQL {
  const s = sort ?? sheet.sort ?? datedOrder(sheet);
  if (!s) return sql`r.seq`;
  const c = columnOf(sheet, s.column);
  if (!inDatabase(c)) throw new KernelError(`${c.name} changes every day, so rows can't be sorted by it.`);
  const key = (by: { column: string; dir: "asc" | "desc" }) => {
    const col = columnOf(sheet, by.column);
    if (!inDatabase(col)) throw new KernelError(`${col.name} changes every day, so rows can't be sorted by it.`);
    return sql`${sortKey(sheet, col, titleOf)} ${by.dir === "desc" ? sql`desc` : sql`asc`} nulls last`;
  };
  // The sheet's own order may have a second key; a sort the person picks has one.
  const own = sheet.sort ?? datedOrder(sheet);
  const then = !sort && own?.then ? sql`, ${key(own.then)}` : sql``;
  return sql`${key({ column: c.id, dir: s.dir })}${then}, r.seq`;
}

// A dated sheet's own order, when it names none (M30): by its key, then the newest first, so the row in force sits
// under the one still to come.
function datedOrder(sheet: Sheet): Sheet["sort"] {
  const d = datedOf(sheet);
  if (!d) return undefined;
  const newest = { column: d.from, dir: "desc" as const };
  return d.key ? { column: d.key, dir: "asc", then: newest } : newest;
}

// The money columns whose total shows under the table (6a: "Sum $296,400"), and a ledger's amount.
// Not a tree's totals that include the rows under it (M28): added up again, a row would count once for every row
// above it.
export function summedColumns(sheet: Sheet): Column[] {
  // A dated sheet's values each apply in their own time (M30): added up, they mean nothing.
  if (datedOf(sheet)) return [];
  return sheet.columns.filter(
    (c) =>
      !c.hintFor &&
      inDatabase(c) &&
      // A ledger's amount too, money or not: its entries add up to the balance (M29, "Sum −3 days").
      (c.type === "money" || (c.type === "computed" && c.result === "money") || c.id === ledgerOf(sheet)?.amount) &&
      !includesRowsUnder(sheet, c) &&
      // A ledger's balance after each entry (M29): a running total, so adding it up means nothing.
      c.id !== ledgerOf(sheet)?.balance,
  );
}

// A tree's column that adds up its own sheet through the row each sits under.
export const includesRowsUnder = (sheet: Sheet, c: Column) =>
  sheet.kind === "tree" && c.type === "computed" && !!c.expr && [...walk(c.expr)].some((n) => isSumOf(n) && n.sumOf.sheet === sheet.id && n.sumOf.by === sheet.tree?.parent);

// Grouping a sheet's rows (0.4, M20): by a step, choice, person or linked row; by the team of a person column (from
// People); or by the month of a date. `key` is what rows of one group share; `order` sorts the groups.
export type GroupBy = { column: string; by?: "team" | "month" };

export function groupable(sheet: Sheet, g: GroupBy): boolean {
  const c = sheet.columns.find((x) => x.id === g.column);
  if (!c || c.hintFor) return false;
  if (g.by === "team") return c.type === "person";
  if (g.by === "month") return c.type === "date" || c.type === "datetime";
  return PICKED.has(c.type);
}

export function groupKeySql(sheet: Sheet, g: GroupBy): SQL {
  const c = columnOf(sheet, g.column);
  if (!groupable(sheet, g)) throw new KernelError(`Rows can't be grouped by ${c.name}.`);
  if (g.by === "team") return sql`(select p.team from people p where p.id::text = ${value(c)})`;
  if (g.by === "month") return sql`substr(${value(c)}, 1, 7)`;
  return value(c);
}

// The order groups come in: a step's or choice's own order, people and linked rows by name, teams by name, months in
// time; rows without a value last.
export function groupOrderSql(sheet: Sheet, g: GroupBy, titleOf: (sheetId: string, capId?: string) => string | null): SQL {
  const c = columnOf(sheet, g.column);
  if (g.by) return sql`${groupKeySql(sheet, g)} asc nulls last`;
  return sql`${sortKey(sheet, c, titleOf)} asc nulls last`;
}
