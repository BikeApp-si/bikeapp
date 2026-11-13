import { formatDate, formatMoney, MONTHS as NAMED, type Formats } from "@/lib/format";
import { renderExpr } from "../expr/render";
import type { NewRow } from "../rows";
import type { Column, Sheet } from "../schema/file";
import { byName, norm } from "./names";

// An uploaded file read into a sheet (5g). The AI only says which file column goes to which sheet column (and
// how dates are written); the kernel reads every row itself and decides what happens to rows that need a
// check, in plain words. Nothing is imported until Create, and then all or nothing.

// Columns a file's text can't fill.
const UNFILLABLE = new Set(["computed", "link", "file"]);

export type Mapping = { from: string; to: string; format: string | null; values: { file: string; means: string }[] };

// A file checked for import, as a chat keeps it until the rows come in (5g, and 5i's Import a spreadsheet).
export type CheckedFile = {
  uploadId: string;
  fileName: string;
  sheet: string; // the sheet's name
  rows: number;
  columns: number;
  mapping: { from: string; to: string; example: string }[];
  unmapped: string[];
  checks: { row: string; issue: string; action: string }[];
  using: Mapping[]; // prompt 2b's mapping, read again when the rows are imported
};

export type ImportCheck = {
  rows: NewRow[];
  mapping: { from: string; to: string; example: string }[];
  unmapped: string[];
  checks: { row: string; issue: string; action: string }[];
  problems: string[]; // the mapping names something that isn't there (for the AI's retry)
  // Rows left out only because required columns are empty: in a build they can come in at the first step,
  // waiting on someone to fill them in (4c's question). missing: the empty columns' ids.
  gaps: { row: string; values: Record<string, unknown>; missing: string[] }[];
};

// name, first name or email → id; id → name; and how the company writes money and dates, for 5g's examples (M26).
type People = { byKey: ReadonlyMap<string, string>; names: ReadonlyMap<string, string>; formats?: Formats };

// People by full name, by a first name nobody else has, and by work email.
export function peopleKeys(people: { id: string; name: string; email: string }[]): People {
  const byKey = new Map<string, string>();
  const firsts = new Map<string, string[]>();
  for (const p of people) {
    byKey.set(norm(p.name), p.id);
    byKey.set(norm(p.email), p.id);
    const first = norm(p.name.split(" ")[0]!);
    firsts.set(first, [...(firsts.get(first) ?? []), p.id]);
  }
  for (const [first, ids] of firsts) if (ids.length === 1 && !byKey.has(first)) byKey.set(first, ids[0]!);
  return { byKey, names: new Map(people.map((p) => [p.id, p.name])) };
}

const MONTHS = NAMED.map((m) => m.toLowerCase());
const pad = (n: number) => String(n).padStart(2, "0");
const valid = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};

// A date as the file writes it, in the format the mapping names.
export function readDate(v: string, format: string | null): string | null {
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return valid(+m[1]!, +m[2]!, +m[3]!);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return format?.toUpperCase().startsWith("DD") ? valid(+m[3]!, +m[2]!, +m[1]!) : valid(+m[3]!, +m[1]!, +m[2]!);
  m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/);
  if (m) {
    const month = MONTHS.indexOf(m[1]!.toLowerCase()) + 1;
    return month ? valid(+m[3]!, month, +m[2]!) : null;
  }
  // "14 Nov 2026", as a company in India writes it (M26).
  m = s.match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]*\.?,? (\d{4})$/);
  if (m) {
    const month = MONTHS.indexOf(m[2]!.toLowerCase()) + 1;
    return month ? valid(+m[3]!, month, +m[1]!) : null;
  }
  return null;
}

export function readAmount(v: string): number | null {
  const s = v.replace(/[\p{Sc},\s]/gu, "");
  return /^-?\d+(\.\d+)?$/.test(s) ? Math.round(Number(s) * 100) : null;
}

export function checkImport(sheet: Sheet, table: string[][], mapping: Mapping[], people: People): ImportCheck {
  const [header = [], ...lines] = table;
  const problems: string[] = [];
  const col = (name: string) => header.findIndex((h) => norm(h) === norm(name));
  const used = mapping.flatMap((m) => {
    const target = byName(sheet.columns, m.to);
    const at = col(m.from);
    if (!target || target.type === "computed") problems.push(`${sheet.name} has no column “${m.to}” to fill.`);
    // A link holds a row and a file column an uploaded file, which a file's text can't give: leave them unmapped.
    else if (target.type === "link") problems.push(`${target.name} links to another sheet, so a file can't fill it; leave it unmapped.`);
    else if (target.type === "file") problems.push(`${target.name} holds an uploaded file, so a file's text can't fill it; leave it unmapped.`);
    if (at < 0) problems.push(`The file has no column “${m.from}”.`);
    return target && !UNFILLABLE.has(target.type) && at >= 0 ? [{ m, target, at }] : [];
  });
  const stepCol = sheet.columns.find((c) => c.type === "step");
  const start = sheet.steps?.find((s) => s.start);
  const unmapped = header.filter((h) => !used.some((u) => norm(u.m.from) === norm(h)));
  const checks: ImportCheck["checks"] = [];
  const title = (line: string[]) => {
    const t = used.find((u) => u.target.id === sheet.titleColumn);
    return (t ? line[t.at] : line[0])?.trim() || "A row";
  };
  const ctx = { column: (id: string) => sheet.columns.find((c) => c.id === id), otherColumn: () => ({ sheet: "", column: "" }) };

  // One cell, or why it can't be read.
  function read(c: Column, m: Mapping, raw: string): { value: unknown } | { issue: string } {
    const v = raw.trim();
    switch (c.type) {
      case "money": {
        const n = readAmount(v);
        return n === null ? { issue: `${m.from} “${v}” isn't an amount` } : { value: n };
      }
      case "number": case "days": case "percent": {
        const n = Number(v.replace(/[,%\s]/g, ""));
        return Number.isFinite(n) ? { value: n } : { issue: `${m.from} “${v}” isn't a number` };
      }
      case "date": {
        const d = readDate(v, m.format);
        return d ? { value: d } : { issue: `${m.from} “${v}” isn't a date` };
      }
      case "person": {
        const id = people.byKey.get(norm(v));
        return id ? { value: id } : { issue: `${c.name} “${v}” is not in People` };
      }
      case "choice": case "step": {
        const found = meantIn(m, v, c.type === "step" ? sheet.steps : c.options);
        return found ? { value: found.id } : { issue: `${m.from} “${v}” isn't one of the ${c.type === "step" ? "steps" : "choices"}` };
      }
      default:
        return { value: v };
    }
  }

  const rows: NewRow[] = [];
  const gaps: ImportCheck["gaps"] = [];
  for (const line of lines) {
    const values: Record<string, unknown> = {};
    const here: ImportCheck["checks"] = [];
    let skip = false;
    let unreadable = false;
    for (const { m, target, at } of used) {
      const raw = (line[at] ?? "").trim();
      if (!raw) continue;
      const got = read(target, m, raw);
      if ("value" in got) {
        values[target.id] = got.value;
        continue;
      }
      // What the kernel does instead, in the column's own terms.
      if (target.type === "person" && target.default?.kind === "creator") here.push({ row: title(line), issue: got.issue, action: `Set the ${target.name.toLowerCase()} to you` });
      else if (target.type === "step") here.push({ row: title(line), issue: got.issue, action: `Put it at ${start?.name ?? "the first step"}` });
      else if (target.required) {
        here.push({ row: title(line), issue: got.issue, action: "Leave this row out" });
        skip = true;
        unreadable = true;
      } else here.push({ row: title(line), issue: got.issue, action: `Leave ${target.name} empty` });
    }
    // An empty cell a default fills, when the default has what it needs ("Set Renews on to Start + 1 year").
    for (const { m, target } of used) {
      if (values[target.id] !== undefined || target.default?.kind !== "expr") continue;
      const needs = JSON.stringify(target.default.expr).match(/"col":"([a-z0-9_]+)"/g)?.map((s) => s.slice(7, -1)) ?? [];
      if (needs.some((id) => values[id] === undefined)) continue;
      const what = /date/i.test(m.from) || target.type !== "date" ? m.from.toLowerCase() : `${m.from.toLowerCase()} date`;
      here.push({ row: title(line), issue: `No ${what}`, action: `Set ${target.name} to ${renderExpr(target.default.expr, ctx)}` });
    }
    const empty = sheet.columns.filter((x) => x.required && x.type !== "step" && !x.default && values[x.id] === undefined);
    if (!skip && empty.length) {
      here.push({ row: title(line), issue: `No ${empty[0]!.name.toLowerCase()}`, action: "Leave this row out" });
      skip = true;
    }
    if (!unreadable && empty.length) gaps.push({ row: title(line), values: stepCol && start ? { ...values, [stepCol.id]: start.id } : values, missing: empty.map((c) => c.id) });
    checks.push(...here);
    if (!skip) rows.push({ values: stepCol && values[stepCol.id] === undefined && start ? { ...values, [stepCol.id]: start.id } : values });
  }

  // 5g's table: each file column, where it goes, and the first row's value as it will read.
  const first = lines[0] ?? [];
  const example = (c: Column, m: Mapping, at: number) => {
    const got = read(c, m, first[at] ?? "");
    if (!("value" in got) || got.value === "") return "—";
    const v = got.value;
    if (c.type === "money") return formatMoney(v as number, people.formats);
    if (c.type === "date") return formatDate(v as string, people.formats);
    if (c.type === "person") return people.names.get(v as string) ?? "—";
    if (c.type === "step") return sheet.steps?.find((s) => s.id === v)?.name ?? "—";
    if (c.type === "choice") return c.options?.find((o) => o.id === v)?.name ?? "—";
    return String(v);
  };
  const stepNames = (m: Mapping, c: Column) => {
    const seen = [...new Set(lines.map((l) => l[col(m.from)]?.trim() ?? "").filter(Boolean))]
      .map((v) => {
        const got = read(c, m, v);
        return "value" in got ? sheet.steps?.find((s) => s.id === got.value)?.name : undefined;
      })
      .filter((n): n is string => !!n);
    const order = (sheet.steps ?? []).map((s) => s.name).filter((n) => seen.includes(n));
    return `${c.name}: ${order.slice(0, 2).join(", ")}${order.length > 2 ? "…" : ""}`;
  };
  return {
    rows,
    mapping: used.map(({ m, target, at }) => ({
      from: m.from,
      to: target.type === "person" ? `${target.name} (matched to People)` : target.type === "step" ? stepNames(m, target) : target.name,
      example: example(target, m, at),
    })),
    unmapped,
    checks,
    problems,
    gaps,
  };
}

// A build's choice values the design missed (M25). While a capability is being built nothing is live, so a value
// the file uses in a choice column that the design left out ("Personal" leave) is added as a choice rather than
// leaving its rows out. At most FOUND_MAX new values a column: more, and the column is likely free text, so its
// rows are left out as before. Steps are never added this way. A value longer than a choice's name may be (80
// characters) is free text too: the column is left alone (M28, a Time off build refused for one).
export const FOUND_MAX = 5;

// The choice or step a file's value stands for: the one the mapping says it means, else the one it names itself.
// What the mapping says counts only when it names one ("Personal" means "No matching choice…" doesn't), so a
// value it couldn't place stays the file's own (G1).
function meantIn<T extends { name: string }>(m: Mapping, v: string, list: T[] | undefined): T | undefined {
  const said = m.values.find((x) => norm(x.file) === norm(v))?.means;
  return (said ? byName(list, said) : undefined) ?? byName(list, v);
}
const CHOICE_NAME_MAX = 80;
export function foundChoices(sheet: Sheet, table: string[][], mapping: Mapping[]): { column: string; values: string[] }[] {
  const [header = [], ...lines] = table;
  const out: { column: string; values: string[] }[] = [];
  for (const m of mapping) {
    const c = byName(sheet.columns, m.to);
    const at = header.findIndex((h) => norm(h) === norm(m.from));
    if (!c || c.type !== "choice" || at < 0) continue;
    const found = new Map<string, string>();
    for (const line of lines) {
      const v = line[at]?.trim();
      if (!v) continue;
      if (!meantIn(m, v, c.options) && !found.has(norm(v))) found.set(norm(v), v);
    }
    const values = [...found.values()];
    if (values.length && values.length <= FOUND_MAX && values.every((v) => v.length <= CHOICE_NAME_MAX)) out.push({ column: c.name, values });
  }
  return out;
}
