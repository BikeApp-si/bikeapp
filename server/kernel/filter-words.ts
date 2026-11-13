import { accessTo } from "./access";
import type { Formats } from "@/lib/format";
import { AccessError, KernelError, load, todayIn, type KernelCtx } from "./context";
import { filterSql, type Filter } from "./query";
import type { Column, Sheet } from "./schema/file";
import type { Tx } from "./tx";
import { peoplePicker, rowWords } from "./views";

// Filters in plain words (0.4, M21). The small model reads the request against the sheet's columns, by name, and
// answers with filters by name; the kernel turns the names into the sheet's ids, checks every value and every filter
// (filterSql), and says plainly what it couldn't use. The AI never writes ids or SQL, and sees only the columns,
// steps, choices and people the person could pick in the Filter menu themselves.

const PICKED = new Set(["step", "choice", "person"]);
const TEXT = new Set(["text", "long_text", "email", "phone", "url"]);
const NUMBER = new Set(["number", "percent", "days"]);
// The columns the Filter menu offers (components/data/filter-sort.tsx `usable`): the same ones here.
const usable = (c: Column) => !c.hintFor && (PICKED.has(c.type) || TEXT.has(c.type) || NUMBER.has(c.type) || c.type === "money" || c.type === "date");

export type WordsColumn = { name: string; type: string; options?: string[] };
export type WordsInput = {
  today: string;
  sheet: { name: string; one: string; many: string };
  columns: WordsColumn[];
  people: { name: string; team: string | null }[];
  request: string;
  formats?: Formats; // the company's currency and financial year (M26)
};
export type WordFilter = {
  column: string;
  op: "in" | "contains" | "between";
  values?: string[] | null;
  text?: string | null;
  from?: string | number | null;
  to?: string | number | null;
};
export type WordsAnswer = { filters: WordFilter[]; could_not: string[] };

// What the prompt may read, and what the answer is checked against afterwards.
export async function filterWordsInput(tx: Tx, ctx: KernelCtx, capId: string, sheetId: string, request: string) {
  const loaded = await load(tx);
  const access = await accessTo(tx, loaded, capId, ctx.actor.id);
  const sheet = access?.cap.file.sheets.find((s) => s.id === sheetId);
  if (!access || !sheet || !access.can("see", sheetId)) throw new AccessError("That sheet doesn't exist, or you can't see it.");
  const text = request.trim();
  if (!text) throw new KernelError("Describe the rows you want to see.");
  if (text.length > 300) throw new KernelError("Keep it to a sentence or two.");
  const people = (await peoplePicker(tx)).map((p) => ({ id: p.id, name: p.name, team: p.team }));
  const { row } = rowWords(sheet);
  const input: WordsInput = {
    today: todayIn(loaded.timeZone, ctx.now),
    sheet: { name: sheet.name, one: row.one, many: row.many },
    columns: sheet.columns.filter(usable).map((c) => ({
      name: c.name,
      type: c.type,
      ...(c.type === "step" ? { options: (sheet.steps ?? []).map((s) => s.name) } : c.type === "choice" ? { options: (c.options ?? []).map((o) => o.name) } : {}),
    })),
    people: people.map((p) => ({ name: p.name, team: p.team })),
    request: text,
    formats: loaded.formats,
  };
  return { input, sheet, people: people.map((p) => ({ id: p.id, name: p.name })) };
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (v: string) => DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

// The answer as the sheet's filters, each checked; anything the kernel can't use is said in plain words instead.
export function filtersFrom(sheet: Sheet, people: { id: string; name: string }[], answer: WordsAnswer): { filters: Filter[]; couldNot: string[] } {
  const filters: Filter[] = [];
  const couldNot = answer.could_not.map((s) => s.trim()).filter(Boolean);
  const columns = sheet.columns.filter(usable);
  for (const f of answer.filters) {
    const col = columns.find((c) => same(c.name, f.column));
    if (!col) {
      couldNot.push(`${sheet.name} has no column “${f.column}” to filter by.`);
      continue;
    }
    const made = one(sheet, col, people, f);
    if (typeof made === "string") {
      couldNot.push(made);
      continue;
    }
    try {
      filterSql(sheet, [made]);
      filters.push(made);
    } catch (e) {
      if (!(e instanceof KernelError)) throw e;
      couldNot.push(e.message);
    }
  }
  return { filters, couldNot };
}

function one(sheet: Sheet, col: Column, people: { id: string; name: string }[], f: WordFilter): Filter | string {
  if (PICKED.has(col.type)) {
    if (f.op !== "in" || !f.values?.length) return `${col.name} is picked from a list, so it needs the names to show.`;
    const options =
      col.type === "step"
        ? (sheet.steps ?? []).map((s) => ({ id: s.id, name: s.name }))
        : col.type === "choice"
          ? (col.options ?? []).map((o) => ({ id: o.id, name: o.name }))
          : people;
    const ids: string[] = [];
    for (const v of f.values) {
      const found = options.find((o) => same(o.name, v));
      if (!found) return `${col.name} has no “${v}”.`;
      if (!ids.includes(found.id)) ids.push(found.id);
    }
    return { column: col.id, op: "in", values: ids };
  }
  if (TEXT.has(col.type)) {
    const text = f.text?.trim();
    if (f.op !== "contains" || !text) return `${col.name} is text, so it needs the words to look for.`;
    return { column: col.id, op: "contains", text };
  }
  if (f.op !== "between" || (f.from == null && f.to == null)) return `${col.name} needs a from or a to.`;
  const ends: (number | string | null)[] = [];
  for (const v of [f.from, f.to]) {
    if (v == null) {
      ends.push(null);
      continue;
    }
    if (col.type === "date") {
      if (typeof v !== "string" || !realDay(v)) return `${col.name} needs a real date.`;
      ends.push(v);
    } else {
      const n = typeof v === "number" ? v : Number(String(v).replace(/[\p{Sc},\s]/gu, ""));
      if (!Number.isFinite(n)) return `${col.name} needs a number.`;
      // Money is kept in cents; the answer gives the currency's whole units.
      ends.push(col.type === "money" ? Math.round(n * 100) : n);
    }
  }
  const [from, to] = ends;
  if (from != null && to != null && from > to) return `${col.name}'s from comes after its to.`;
  return { column: col.id, op: "between", from, to };
}
