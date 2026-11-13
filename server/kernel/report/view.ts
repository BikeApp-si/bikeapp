import { dayIn, formatDate, formatDay, formatMoney, formatNumber, US, type Formats } from "@/lib/format";
import { monthLabel } from "./run";
import { todayIn } from "../context";
import type { ColumnFormat, ReportQuery, ReportResult } from "./schema";
import type { StoredReport } from "./store";

// A report as a reply, a panel, a CSV and a PDF show it (11c–11i, 12c–12d), worked out by the kernel: values
// formatted, the chart's numbers, the card's line, and on Run again the table that sets the two runs side by
// side. Plus the check of prompt 7's sentence: every number in it comes from the table.

export function formatCell(v: string | number | null, format: ColumnFormat, years: Set<string>, fmt: Formats = US): string {
  if (v === null || v === "") return "—";
  if (format === "money" && typeof v === "number") return formatMoney(Math.round(v * 100), fmt).replace(/\.00$/, "");
  if (format === "percent" && typeof v === "number") return `${Math.round(v)}%`;
  if (format === "number" && typeof v === "number") return formatNumber(v, fmt);
  if (format === "month") return monthLabel(String(v), years);
  if (format === "date" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return formatDay(v, fmt);
  return String(v);
}

const yearsOf = (r: ReportResult) => new Set(r.columns.flatMap((c, i) => (c.format === "month" ? r.rows.map((row) => String(row[i]).slice(0, 4)) : [])));

// "Oct 26, 10:02" (or "Oct 26, 2026, 10:02"; "26 Oct 2026, 10:02" day first), in the workspace's time zone.
export function when(at: Date, timeZone: string, year = false, fmt: Formats = US): string {
  const d = year ? formatDate(dayIn(at, timeZone), fmt) : formatDay(dayIn(at, timeZone), fmt);
  const t = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  return `${d}, ${t}`;
}

export type ReportView = {
  id: string;
  title: string;
  ranAt: string; // "Oct 26, 10:02"
  ranOn: string; // "Oct 26, 2026, 10:02", for the PDF (11h)
  firstId: string | null;
  sources: string; // "Spend and Tools and budgets"
  period: string | null; // "Oct 1–26, 2026", from the query's dates
  card: string; // "Report · Spend, Tools and budgets · 128 purchases"
  how: string[];
  chart: { kind: "bar" | "line" | "none"; labels: string[]; formats: Formats; series: { name: string; role: "measure" | "comparison" | "target"; format: ColumnFormat; values: (number | null)[] }[] };
  table: { columns: string[]; rows: string[][]; numeric: boolean[] }; // in chat and the panel (11c, 11d)
  print: { columns: string[]; rows: string[][]; total: string[] | null; numeric: boolean[] }; // the PDF's (11h)
  csv: { columns: string[]; rows: (string | number)[][] }; // 11i: plain numbers, then the total
};

const and = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

export function reportView(r: StoredReport, rowWords: (sheet: string) => { one: string; many: string }, timeZone: string, first?: StoredReport, fmt: Formats = US): ReportView {
  const chartSpec = { kind: r.chart, series: r.series };
  const res = r.result;
  const years = yearsOf(res);
  const caps = [...new Set(res.sources.map((s) => s.capability))];
  const base = res.sources[0];
  const words = base ? rowWords(base.sheet) : { one: "row", many: "rows" };
  const read = base ? `${formatNumber(base.read, fmt)} ${base.read === 1 ? words.one : words.many}` : "";
  const groups = res.columns.filter((c) => c.format === "text" || c.format === "month" || c.format === "date").length;
  const labels = res.rows.map((row) => res.columns.slice(0, Math.max(1, groups)).map((c, i) => formatCell(row[i] ?? null, c.format, years, fmt)).join(", "));
  const series = chartSpec.series.flatMap((s) => {
    const at = res.columns.findIndex((c) => c.name.toLowerCase() === s.column.toLowerCase());
    return at < 0 ? [] : [{ name: res.columns[at]!.name, role: s.role, format: res.columns[at]!.format, values: res.rows.map((row) => (typeof row[at] === "number" ? (row[at] as number) : null)) }];
  });

  const cells = (row: (string | number | null)[]) => row.map((v, i) => formatCell(v, res.columns[i]!.format, years, fmt));
  const numeric = res.columns.map((c) => c.format === "money" || c.format === "number" || c.format === "percent");
  const print = { columns: res.columns.map((c) => c.name), rows: res.rows.map(cells), total: res.total && res.rows.length > 1 ? cells(res.total).map((c, i) => (i > 0 && c === "—" ? "" : c)) : null, numeric };
  // In chat a computed percent rides with the money before it: "$10,800 (82% used)" (11c).
  const rides = res.columns.map((c, i) => i > 0 && c.format === "percent" && res.columns[i - 1]!.format === "money" && r.query.computed.some((x) => x.as === c.name));
  let table = {
    columns: res.columns.filter((_, i) => !rides[i]).map((c) => c.name),
    rows: res.rows.map((row) => cells(row).flatMap((c, i) => (rides[i] ? [] : rides[i + 1] && row[i + 1] !== null ? [`${c} (${formatCell(row[i + 1]!, "percent", years, fmt)} ${res.columns[i + 1]!.name.toLowerCase()})`] : [c]))),
    numeric: numeric.filter((_, i) => !rides[i]),
  };
  // Run again (12d): the groups, what stayed the same, and the main measure from each run.
  if (first) {
    const measure = chartSpec.series.find((s) => s.role === "measure")?.column.toLowerCase();
    const at = res.columns.findIndex((c) => c.name.toLowerCase() === measure);
    const fr = first.result;
    const atFirst = fr.columns.findIndex((c) => c.name.toLowerCase() === measure);
    if (at >= 0 && atFirst >= 0) {
      const kept = res.columns.map((c, i) => i).filter((i) => i < groups || chartSpec.series.some((s) => s.role !== "measure" && s.column.toLowerCase() === res.columns[i]!.name.toLowerCase()));
      const day = (d: Date) => formatDay(dayIn(d, timeZone), fmt);
      const firstOf = (row: (string | number | null)[]) => fr.rows.find((x) => JSON.stringify(x.slice(0, groups)) === JSON.stringify(row.slice(0, groups)))?.[atFirst] ?? null;
      table = {
        columns: [...kept.map((i) => res.columns[i]!.name), day(first.ranAt), day(r.ranAt)],
        rows: res.rows.map((row) => [...kept.map((i) => formatCell(row[i] ?? null, res.columns[i]!.format, years, fmt)), formatCell(firstOf(row), res.columns[at]!.format, years, fmt), formatCell(row[at] ?? null, res.columns[at]!.format, years, fmt)]),
        numeric: [...kept.map((i) => i >= groups), true, true],
      };
    }
  }
  return {
    id: r.id,
    title: r.title,
    ranAt: when(r.ranAt, timeZone, false, fmt),
    ranOn: when(r.ranAt, timeZone, true, fmt),
    firstId: r.firstId,
    sources: and(caps),
    period: periodOf(r.query, r.ranAt, timeZone, fmt),
    card: first ? `Report · ${when(r.ranAt, timeZone, false, fmt)} · ${read}` : `Report · ${caps.join(", ")} · ${read}`,
    how: r.how,
    chart: { kind: first ? "none" : chartSpec.kind, labels, formats: fmt, series },
    table,
    print,
    csv: { columns: res.columns.map((c) => c.name), rows: [...res.rows, ...(print.total ? [res.total!] : [])].map((row) => row.map((v, i) => plainCell(v, res.columns[i]!.format, years))) },
  };
}

// 11i: money and numbers as plain numbers, a percent with its sign, months by name.
const plainCell = (v: string | number | null, format: ColumnFormat, years: Set<string>): string | number =>
  v === null ? "" : format === "month" ? formatCell(v, "month", years) : format === "percent" && typeof v === "number" ? `${Math.round(v)}%` : v;

// The period a report covers, from its first "between" on a date: "Oct 1–26, 2026", "Jul 1–Oct 26, 2026"; day
// first, "1–26 Oct 2026", "1 Jul–26 Oct 2026". "Today" is the day it ran.
export function periodOf(q: ReportQuery, ranAt: Date, timeZone: string, fmt: Formats = US): string | null {
  const find = (e: unknown): unknown[] | null => {
    if (!e || typeof e !== "object" || !("op" in e)) return null;
    const x = e as { op: string; args: unknown[] };
    if (x.op === "between") return x.args;
    if (x.op === "and") for (const a of x.args) { const f = find(a); if (f) return f; }
    return null;
  };
  const args = find(q.where);
  const day = (v: unknown) => (v && typeof v === "object" && "ref" in v ? todayIn(timeZone, ranAt) : typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const [from, to] = [day(args?.[1]), day(args?.[2])];
  if (!from || !to) return null;
  const md = (d: string) => formatDay(d, fmt);
  if (fmt.dates === "dmy") {
    if (from.slice(0, 4) !== to.slice(0, 4)) return `${formatDate(from, fmt)}–${formatDate(to, fmt)}`;
    const start = from.slice(5, 7) === to.slice(5, 7) ? String(Number(from.slice(8, 10))) : md(from);
    return `${start}–${md(to)} ${to.slice(0, 4)}`;
  }
  if (from.slice(0, 4) !== to.slice(0, 4)) return `${md(from)}, ${from.slice(0, 4)}–${md(to)}, ${to.slice(0, 4)}`;
  const end = from.slice(5, 7) === to.slice(5, 7) ? String(Number(to.slice(8, 10))) : md(to);
  return `${md(from)}–${end}, ${to.slice(0, 4)}`;
}

// ── The sentence's check ──

const numbersIn = (s: string) => (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => Number(n.replace(/,/g, "")));

// Every number the sentence may use: cells (and numbers in their words), column totals, rows read, an earlier
// run's cells and totals and the differences from them, and numbers in the question, how and missing (dates, years).
export function allowedNumbers(r: ReportResult, extra: string[], previous?: ReportResult): Set<number> {
  const out = new Set<number>();
  const totals = (x: ReportResult) => x.columns.map((_, i) => x.rows.reduce((n, row) => n + (typeof row[i] === "number" ? (row[i] as number) : 0), 0));
  const t = totals(r);
  // Numbers in words count too: "4 of 6 tasks done", "Nov 16".
  for (const row of r.rows) for (const v of row) (typeof v === "number" ? [v, Math.round(v)] : typeof v === "string" ? numbersIn(v) : []).forEach((x) => out.add(x));
  t.forEach((v) => out.add(Math.round(v)));
  for (const a of t) for (const b of t) if (b) out.add(Math.round((a / b) * 100));
  r.sources.forEach((s) => [s.read, s.leftOut].forEach((x) => out.add(x)));
  if (previous) {
    const p = totals(previous);
    t.forEach((v, i) => out.add(Math.round(Math.abs(v - (p[i] ?? 0)))));
    p.forEach((v) => out.add(Math.round(v)));
    for (const row of previous.rows) for (const v of row) if (typeof v === "number") out.add(Math.round(v));
    previous.sources.forEach((s) => out.add(s.read));
  }
  for (const s of extra) numbersIn(s).forEach((x) => out.add(x));
  return out;
}

export function checkSentence(sentence: string, allowed: Set<number>): string[] {
  const label = /^[\s*]*[A-Za-z ]{1,20}:/.test(sentence) ? ["Start with a plain sentence, not a label such as “Missing:”."] : [];
  return [
    ...label,
    ...numbersIn(sentence)
      .filter((n) => !allowed.has(n) && !allowed.has(Math.round(n)))
      .map((n) => `${n.toLocaleString("en-US")} isn't in the table, its totals or rows read; use only those.`),
  ];
}

// Bold that was opened and never closed would show its marks; then the sentence goes without bold.
export const tidyBold = (sentence: string) => ((sentence.match(/\*\*/g) ?? []).length % 2 ? sentence.replace(/\*\*/g, "") : sentence);
