import { inArray } from "drizzle-orm";
import { rows as rowsTable } from "@/db/schema";
import { mustBeAdmin } from "../admin";
import { capabilitiesFor } from "../capabilities";
import { currentTime } from "../clock";
import { load, todayIn, type KernelCtx } from "../context";
import { isCol, walk, type Expr } from "../expr/ast";
import { evaluate } from "../expr/evaluate";
import { byName } from "../plans/names";
import { listRows } from "../rows";
import type { CapabilityFile, Column, Sheet } from "../schema/file";
import type { Tx } from "../tx";
import type { ColumnFormat, ReportQuery, ReportResult } from "./schema";

// Running a report's query (11a–11g) with the asking admin's access, the same every time. Each source's
// rows are read through listRows (so the admin sees only what they may), as of a time (rows written by
// then), and turned into plain values. Each source is filtered by its own conditions; the first source is
// grouped; every other source's rows are added up per group through its join, so a team's budget is counted
// once, not once for each of the team's purchases.

type Plain = Record<string, unknown>; // column name → plain value (money in dollars, choices by name)
type Loaded = { name: string; capability: string; sheet: Sheet; file: CapabilityFile; rows: { id: string; plain: Plain; links: Record<string, string> }[] };
export type Visible = Map<string, { file: CapabilityFile; id: string }>; // capability name (lower case) → file

const lower = (s: string) => s.trim().toLowerCase();
const split = (ref: string) => {
  const at = ref.indexOf(".");
  return [ref.slice(0, at), ref.slice(at + 1)] as const;
};
const colRefs = (e: Expr) => [...walk(e)].filter(isCol).map((c) => c.col);

// ── The check ──

function sourcesOf(q: ReportQuery, visible: Visible, problems: string[]) {
  const out = new Map<string, { capability: string; capId: string; file: CapabilityFile; sheet: Sheet }>();
  for (const s of q.from) {
    const cap = visible.get(lower(s.capability));
    const sheet = cap && byName(cap.file.sheets, s.sheet);
    if (!cap) problems.push(`There is no app “${s.capability}” you can see.`);
    else if (!sheet) problems.push(`${cap.file.name} has no sheet “${s.sheet}”.`);
    else out.set(lower(s.as ?? sheet.name), { capability: cap.file.name, capId: cap.id, file: cap.file, sheet });
  }
  return out;
}

// The conditions, each about one source: an "and" of terms, or one term.
function termsOf(where: Expr | null): Expr[] {
  if (!where) return [];
  return typeof where === "object" && where !== null && "op" in where && where.op === "and" ? where.args : [where];
}

export function checkQuery(q: ReportQuery, visible: Visible): string[] {
  const problems: string[] = [];
  const sources = sourcesOf(q, visible, problems);
  const column = (ref: string) => {
    const [src, col] = split(ref);
    const s = sources.get(lower(src));
    if (!s) return problems.push(`“${src}” isn't one of the report's sources.`), undefined;
    const c = byName(s.sheet.columns, col);
    if (!c) problems.push(`${s.sheet.name} has no column “${col}”.`);
    return c;
  };
  const joined = new Set([lower(q.from[0]?.as ?? q.from[0]?.sheet ?? "")]);
  for (const j of q.join) {
    if (!sources.has(lower(j.source))) problems.push(`The join names “${j.source}”, which isn't one of the report's sources.`);
    const refs = "equal" in j.on ? j.on.equal : "names" in j.on ? j.on.names : [j.on.link];
    refs.forEach(column);
    if ("link" in j.on) {
      const c = column(j.on.link);
      if (c && c.type !== "link") problems.push(`${j.on.link} isn't a link column.`);
    }
    const others = refs.map((r) => lower(split(r)[0])).filter((a) => a !== lower(j.source));
    if (!("link" in j.on) && !others.some((a) => joined.has(a))) problems.push(`The join of ${j.source} must connect it to a source before it.`);
    joined.add(lower(j.source));
  }
  for (const s of sources.keys()) if (!joined.has(s)) problems.push(`Join ${s} to the others, or leave it out.`);
  for (const t of termsOf(q.where)) {
    const refs = colRefs(t);
    refs.forEach(column);
    if (new Set(refs.map((r) => lower(split(r)[0]))).size > 1) problems.push("Each condition must be about one source; join them instead.");
  }
  const base = lower(q.from[0]?.as ?? q.from[0]?.sheet ?? "");
  for (const g of q.groupBy) {
    const ref = "column" in g ? g.column : g.month;
    column(ref);
    if (lower(split(ref)[0]) !== base) problems.push(`Group by a column of ${q.from[0]?.sheet}, the first source.`);
  }
  const names = new Set(q.groupBy.map((g) => split("column" in g ? g.column : g.month)[1].toLowerCase()));
  for (const m of q.measures) {
    if (!sources.has(lower(m.source))) problems.push(`The measure ${m.as} adds up “${m.source}”, which isn't one of the sources.`);
    if (m.column) column(m.column);
    if (m.fn !== "count" && !m.column) problems.push(`${m.as} needs a column to ${m.fn}.`);
    if (m.where) colRefs(m.where).forEach(column);
    names.add(lower(m.as));
  }
  for (const c of q.computed) {
    if (!c.expr && !c.template) problems.push(`${c.as} needs an expression or a template.`);
    for (const r of c.expr ? colRefs(c.expr) : []) if (!names.has(lower(r))) problems.push(`${c.as} uses “${r}”, which isn't a measure or group column.`);
    for (const r of (c.template ?? "").match(/\{([^}]+)\}/g) ?? []) if (!names.has(lower(r.slice(1, -1)))) problems.push(`${c.as} uses “${r.slice(1, -1)}”, which isn't a measure or group column.`);
    names.add(lower(c.as));
  }
  const shown = outputNames(q);
  for (const o of q.orderBy) if (!names.has(orderName(o.column, names))) problems.push(`Order by one of the report's columns (${shown.join(", ")}), not “${o.column}”.`);
  if (!q.measures.length && !q.groupBy.length) problems.push("Add up something, or group by something.");
  return problems;
}

// The capabilities the admin can see, by name, for the check.
export async function visibleFiles(tx: Tx, ctx: KernelCtx): Promise<Visible> {
  const loaded = await load(tx);
  return new Map((await capabilitiesFor(tx, ctx)).map((c) => [lower(c.name), { file: loaded.files.get(c.id)!.file, id: c.id }]));
}

// The names a query's output has: its groups, measures and computed columns.
export function outputNames(q: ReportQuery): string[] {
  return [...q.groupBy.map((g) => ("month" in g ? "Month" : split(g.column)[1])), ...q.measures.filter((m) => !m.hidden).map((m) => m.as), ...q.computed.map((c) => c.as)];
}

// ── Reading the rows ──

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function plainOf(c: Column, v: unknown, sheet: Sheet, people: Map<string, string>, titles: Map<string, string>): unknown {
  if (v === null || v === undefined || v === "") return null;
  const type = c.type === "computed" ? (c.result ?? "text") : c.type;
  switch (type) {
    case "money":
      return typeof v === "number" ? v / 100 : null;
    case "choice":
      return c.options?.find((o) => o.id === v)?.name ?? null;
    case "step":
      return sheet.steps?.find((s) => s.id === v)?.name ?? null;
    case "person":
      return people.get(String(v)) ?? null;
    case "link":
      return titles.get(String(v)) ?? null;
    case "file":
      return "file";
    case "date":
    case "datetime":
      return typeof v === "string" ? v.slice(0, 10) : null;
    default:
      return v;
  }
}

async function read(tx: Tx, ctx: KernelCtx, s: { capability: string; capId: string; file: CapabilityFile; sheet: Sheet }, name: string, asOf: Date, people: Map<string, string>): Promise<Loaded> {
  const found = (await listRows(tx, ctx, s.capId, s.sheet.id)).filter((r) => r.createdAt.getTime() <= asOf.getTime());
  // Titles of the rows link columns point at, for plain values ("Senior backend engineer").
  const linked = [...new Set(found.flatMap((r) => s.sheet.columns.filter((c) => c.type === "link").map((c) => r.data[c.id]).filter((v): v is string => typeof v === "string")))];
  const titles = new Map<string, string>();
  if (linked.length) {
    const loaded = await load(tx);
    for (const t of await tx.select({ id: rowsTable.id, capabilityId: rowsTable.capabilityId, sheetId: rowsTable.sheetId, data: rowsTable.data }).from(rowsTable).where(inArray(rowsTable.id, linked))) {
      const sheet = loaded.files.get(t.capabilityId)?.file.sheets.find((x) => x.id === t.sheetId);
      const title = sheet?.columns.find((c) => c.id === sheet.titleColumn);
      const v = title ? (t.data as Plain)[title.id] : null;
      titles.set(t.id, title?.type === "person" ? (people.get(String(v)) ?? "") : String(v ?? ""));
    }
  }
  return {
    name,
    capability: s.capability,
    sheet: s.sheet,
    file: s.file,
    rows: found.map((r) => ({
      id: r.id,
      plain: Object.fromEntries(s.sheet.columns.map((c) => [c.name.toLowerCase(), plainOf(c, r.data[c.id], s.sheet, people, titles)])),
      links: Object.fromEntries(s.sheet.columns.filter((c) => c.type === "link" && typeof r.data[c.id] === "string").map((c) => [c.name.toLowerCase(), r.data[c.id] as string])),
    })),
  };
}

// ── Running it ──

const truthy = (v: unknown) => v === true;

export async function runReport(tx: Tx, ctx: KernelCtx, q: ReportQuery, opts: { asOf?: Date } = {}): Promise<ReportResult> {
  await mustBeAdmin(tx, ctx);
  const asOf = opts.asOf ?? ctx.now ?? currentTime();
  const loaded = await load(tx);
  const today = todayIn(loaded.timeZone, asOf);
  const visible: Visible = new Map((await capabilitiesFor(tx, ctx)).map((c) => [lower(c.name), { file: loaded.files.get(c.id)!.file, id: c.id }]));
  const problems = checkQuery(q, visible);
  if (problems.length) throw new Error(problems[0]);
  const people = new Map([...loaded.people.values()].map((p) => [p.id, p.name]));
  const defs = sourcesOf(q, visible, []);

  // Each source's rows, kept only where its own conditions hold.
  const terms = termsOf(q.where);
  const data = new Map<string, Loaded>();
  const sources: ReportResult["sources"] = [];
  for (const [name, def] of defs) {
    const l = await read(tx, ctx, def, name, asOf, people);
    const mine = terms.filter((t) => colRefs(t).every((r) => lower(split(r)[0]) === name));
    const kept = l.rows.filter((r) => mine.every((t) => truthy(evaluate(t, { value: (col) => r.plain[lower(split(col)[1])], today }))));
    sources.push({ capability: def.capability, sheet: def.sheet.name, name: q.from.find((f) => lower(f.as ?? f.sheet) === name)?.as ?? def.sheet.name, read: kept.length, leftOut: l.rows.length - kept.length });
    data.set(name, { ...l, rows: kept });
  }

  // The first source's rows, by group.
  const baseName = lower(q.from[0]!.as ?? q.from[0]!.sheet);
  const base = data.get(baseName)!;
  const keyOf = (r: Loaded["rows"][number]) =>
    JSON.stringify(q.groupBy.map((g) => ("column" in g ? r.plain[lower(split(g.column)[1])] : String(r.plain[lower(split(g.month)[1])] ?? "").slice(0, 7))));
  const keysOf = new Map<string, Map<string, Set<string>>>(); // source → row id → group keys
  keysOf.set(baseName, new Map(base.rows.map((r) => [r.id, new Set([keyOf(r)])])));
  for (const j of q.join) {
    const name = lower(j.source);
    const b = data.get(name)!;
    const mine = new Map<string, Set<string>>();
    const keysOfRow = (src: string, id: string) => keysOf.get(src)?.get(id) ?? new Set<string>();
    if ("link" in j.on) {
      const [side, col] = split(j.on.link);
      if (lower(side) === name) {
        // This source's link points at an earlier source's rows.
        const target = [...keysOf.keys()].find((k) => k !== name && byName(b.sheet.columns, col)?.link?.sheet === data.get(k)!.sheet.id);
        for (const r of b.rows) mine.set(r.id, target ? keysOfRow(target, r.links[lower(col)] ?? "") : new Set());
      } else {
        // An earlier source's link points at this source's rows.
        const from = lower(side);
        for (const r of b.rows) mine.set(r.id, new Set(data.get(from)!.rows.filter((x) => x.links[lower(col)] === r.id).flatMap((x) => [...keysOfRow(from, x.id)])));
      }
    } else {
      const pair = "equal" in j.on ? j.on.equal : j.on.names;
      const [mineRef, otherRef] = lower(split(pair[0])[0]) === name ? pair : [pair[1], pair[0]];
      const other = lower(split(otherRef)[0]);
      const index = data.get(other)!.rows.map((x) => ({ v: x.plain[lower(split(otherRef)[1])], keys: keysOfRow(other, x.id) }));
      for (const r of b.rows) {
        const v = r.plain[lower(split(mineRef)[1])];
        const hits =
          "equal" in j.on
            ? index.filter((x) => v !== null && x.v === v)
            : index.filter((x) => typeof x.v === "string" && x.v && typeof v === "string" && (pair[0] === mineRef ? v.toLowerCase().includes(x.v.toLowerCase()) : x.v.toLowerCase().includes(v.toLowerCase())));
        mine.set(r.id, new Set(hits.flatMap((x) => [...x.keys])));
      }
    }
    keysOf.set(name, mine);
  }

  // Groups in a steady order: as the first source's rows come, which is the sheet's own order.
  const groups: string[] = [];
  for (const r of base.rows) if (!groups.includes(keyOf(r))) groups.push(keyOf(r));
  if (!q.groupBy.length && !groups.length) groups.push("[]");

  const values = new Map<string, Record<string, unknown>>(groups.map((g) => [g, Object.fromEntries(q.groupBy.map((x, i) => [lower(split("column" in x ? x.column : x.month)[1]), JSON.parse(g)[i]]))]));
  for (const m of q.measures) {
    const src = lower(m.source);
    const l = data.get(src)!;
    const per = new Map<string, unknown[]>(groups.map((g) => [g, []]));
    for (const r of l.rows) {
      if (m.where && !truthy(evaluate(m.where, { value: (col) => r.plain[lower(split(col)[1])], today }))) continue;
      const v = m.column ? r.plain[lower(split(m.column)[1])] : 1;
      if (m.fn === "count" && m.column && (v === null || v === undefined)) continue;
      for (const k of keysOf.get(src)?.get(r.id) ?? []) per.get(k)?.push(v);
    }
    for (const g of groups) {
      const vs = per.get(g)!;
      const nums = vs.filter((v): v is number => typeof v === "number");
      const out =
        m.fn === "count" ? vs.length
        : m.fn === "sum" ? Math.round(nums.reduce((a, b) => a + b, 0) * 100) / 100
        : m.fn === "avg" ? (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null)
        : m.fn === "min" ? (nums.length ? Math.min(...nums) : null)
        : m.fn === "max" ? (nums.length ? Math.max(...nums) : null)
        : (vs.find((v) => v !== null && v !== undefined) ?? null);
      values.get(g)![lower(m.as)] = out;
    }
  }
  for (const c of q.computed)
    for (const g of groups) {
      const v = values.get(g)!;
      if (c.expr) {
        const out = evaluate(c.expr, { value: (col) => v[lower(col)], today });
        v[lower(c.as)] = typeof out === "number" && c.format === "percent" ? Math.round(out) : out;
      } else {
        const used = (c.template!.match(/\{([^}]+)\}/g) ?? []).map((r) => v[lower(r.slice(1, -1))]);
        const empty = used.every((x) => x === null || x === undefined || x === 0 || x === "");
        v[lower(c.as)] = empty && c.empty !== null ? c.empty : c.template!.replace(/\{([^}]+)\}/g, (_, n: string) => String(v[lower(n)] ?? ""));
      }
    }

  // Columns: the groups, the measures shown, the computed ones.
  const formatOf = (src: string, ref: string | null, fn: string): ColumnFormat => {
    if (fn === "count" || !ref) return "number";
    const c = byName(data.get(lower(src))?.sheet.columns ?? [], split(ref)[1]);
    const t = c?.type === "computed" ? c.result : c?.type;
    return t === "money" ? "money" : t === "date" ? "date" : t === "number" || t === "days" ? "number" : t === "percent" ? "percent" : "text";
  };
  const columns: ReportResult["columns"] = [
    ...q.groupBy.map((g) => {
      const ref = "column" in g ? g.column : g.month;
      const c = byName(base.sheet.columns, split(ref)[1])!;
      return { name: "month" in g ? "Month" : c.name, format: ("month" in g ? "month" : c.type === "date" ? "date" : c.type === "money" ? "money" : "text") as ColumnFormat };
    }),
    ...q.measures.filter((m) => !m.hidden).map((m) => ({ name: m.as, format: formatOf(m.source, m.column, m.fn) })),
    ...q.computed.map((c) => ({ name: c.as, format: c.format as ColumnFormat })),
  ];
  const keys = [
    ...q.groupBy.map((g) => lower(split("column" in g ? g.column : g.month)[1])),
    ...q.measures.filter((m) => !m.hidden).map((m) => lower(m.as)),
    ...q.computed.map((c) => lower(c.as)),
  ];
  let out = groups.map((g) => keys.map((k) => (values.get(g)![k] ?? null) as string | number | null));
  // Months in order; then the query's own order.
  const monthAt = q.groupBy.findIndex((g) => "month" in g);
  if (monthAt >= 0) out.sort((a, b) => String(a[monthAt]).localeCompare(String(b[monthAt])));
  for (const o of [...q.orderBy].reverse()) {
    const name = orderName(o.column, new Set(columns.map((c) => lower(c.name))));
    const at = columns.findIndex((c) => lower(c.name) === name);
    if (at >= 0) out = [...out].sort((a, b) => cmp(a[at], b[at]) * (o.dir === "desc" ? -1 : 1));
  }
  if (q.limit) out = out.slice(0, q.limit);

  // The total row (11h, 11i): sums and counts added up over every group, computed values worked out again on
  // those totals (68% used, not the used percents added up). Others stay empty.
  let total: ReportResult["total"] = null;
  if (q.groupBy.length && groups.length > 1) {
    const t: Record<string, unknown> = {};
    for (const m of q.measures) if (m.fn === "sum" || m.fn === "count") t[lower(m.as)] = Math.round(groups.reduce((n, g) => n + (Number(values.get(g)![lower(m.as)]) || 0), 0) * 100) / 100;
    for (const c of q.computed)
      if (c.expr) {
        const v = evaluate(c.expr, { value: (col) => t[lower(col)], today });
        t[lower(c.as)] = typeof v === "number" && c.format === "percent" ? Math.round(v) : v;
      }
    const row = keys.map((k, i) => (i === 0 ? "Total" : i < q.groupBy.length ? null : ((t[k] ?? null) as string | number | null)));
    // Only when there is a number to total: a list in words (11f) has none.
    if (row.slice(q.groupBy.length).some((v) => typeof v === "number")) total = row;
  }
  return { columns, rows: out, total, sources };
}

// An order names an output column; "Plans.Start date" is taken as "Start date" when the report has one.
const orderName = (column: string, names: Set<string>) => {
  const name = lower(column);
  const tail = name.includes(".") ? name.slice(name.indexOf(".") + 1) : name;
  return names.has(name) || !names.has(tail) ? name : tail;
};

const cmp = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? a - b : String(a ?? "").localeCompare(String(b ?? "")));

// "Jul", or "Jul 2026" when the report spans years.
export function monthLabel(ym: string, years: Set<string>): string {
  const [y, m] = ym.split("-");
  return `${MONTHS[Number(m) - 1] ?? ym}${years.size > 1 ? ` ${y}` : ""}`;
}
