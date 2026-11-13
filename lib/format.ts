// Values as people read them, by column type. The same words in the table, the record panel and the CSV
// export. Safe in the browser: names of people, rows and files are passed in, never looked up here.

export type ColumnLike = {
  type: string;
  result?: string;
  options?: { id: string; name: string }[];
};
export type Names = {
  person?(id: string): string | undefined;
  row?(id: string): string | undefined; // a linked row's title
  file?(id: string): string | undefined;
  step?(id: string): string | undefined;
};

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// How a company writes money, numbers and dates (M26, Settings). The default is Fernwood's: dollars,
// 1,234,567 and "Nov 14, 2026", with the year from January.
export type Formats = {
  currency: string; // ISO 4217, with cents (two minor digits)
  grouping: "standard" | "indian"; // 1,234,567 or 12,34,567
  dates: "mdy" | "dmy"; // "Nov 14, 2026" or "14 Nov 2026"
  yearStart: number; // the financial year's first month, 1 = January
};
export const US: Formats = { currency: "USD", grouping: "standard", dates: "mdy", yearStart: 1 };

// A workspace's stored fields as Formats; empty fields take the default.
export function formatsOf(ws: { currency?: string | null; numberGrouping?: string | null; dateStyle?: string | null; fiscalYearStart?: number | null }): Formats {
  return {
    currency: ws.currency || US.currency,
    grouping: ws.numberGrouping === "indian" ? "indian" : "standard",
    dates: ws.dateStyle === "dmy" ? "dmy" : "mdy",
    yearStart: ws.fiscalYearStart && ws.fiscalYearStart >= 1 && ws.fiscalYearStart <= 12 ? ws.fiscalYearStart : 1,
  };
}

const localeOf = (f: Formats) => (f.grouping === "indian" ? "en-IN" : "en-US");

export function formatMoney(cents: number, f: Formats = US): string {
  const whole = Number.isInteger(cents / 100);
  return new Intl.NumberFormat(localeOf(f), {
    style: "currency",
    currency: f.currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

// "1,234,567" or "12,34,567".
export function formatNumber(n: number, f: Formats = US, options?: Intl.NumberFormatOptions): string {
  return n.toLocaleString(localeOf(f), options);
}

// The currency's own sign, for a money input: "$", "₹", "€".
export function currencySign(f: Formats = US): string {
  return new Intl.NumberFormat(localeOf(f), { style: "currency", currency: f.currency, currencyDisplay: "narrowSymbol" })
    .formatToParts(0)
    .find((p) => p.type === "currency")?.value ?? f.currency;
}

// "Nov 14, 2026" or "14 Nov 2026".
export function formatDate(iso: string, f: Formats = US): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number) as [number, number, number];
  return f.dates === "dmy" ? `${d} ${MONTHS[m - 1]} ${y}` : `${MONTHS[m - 1]} ${d}, ${y}`;
}

// "Oct 15" or "15 Oct": a date without its year.
export function formatDay(iso: string, f: Formats = US): string {
  const [, m, d] = iso.slice(0, 10).split("-").map(Number) as [number, number, number];
  return f.dates === "dmy" ? `${d} ${MONTHS[m - 1]}` : `${MONTHS[m - 1]} ${d}`;
}

// The day (YYYY-MM-DD) a moment falls on in a time zone, to write with formatDay or formatDate.
export function dayIn(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

// "Oct 2026": a month and its year.
export function formatMonth(yearMonth: string): string {
  const [y, m] = yearMonth.slice(0, 7).split("-").map(Number) as [number, number];
  return `${MONTHS[m - 1]} ${y}`;
}

// Two dates as one range (8a): "Dec 28–31", "Sep 30 – Oct 2", or "Jun 2" for a single day; "28–31 Dec" day first.
export function dayRange(from: string, to: string, f: Formats = US): string {
  if (!to || from.slice(0, 10) === to.slice(0, 10)) return formatDay(from, f);
  if (from.slice(0, 7) === to.slice(0, 7)) {
    return f.dates === "dmy" ? `${Number(from.slice(8, 10))}–${formatDay(to, f)}` : `${formatDay(from, f)}–${Number(to.slice(8, 10))}`;
  }
  return `${formatDay(from, f)} – ${formatDay(to, f)}`;
}

// "2026-10-22 14:52:08", in UTC (the Audit log).
export function formatUtc(at: Date): string {
  return at.toISOString().slice(0, 19).replace("T", " ");
}

const DAY = 86_400_000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / DAY);

// "in 25 days", "tomorrow", "today", "yesterday", "3 days ago".
export function relativeDay(iso: string, today: string): string {
  const n = daysBetween(today, iso);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

const plural = (n: number, one: string) => `${n} ${one}${Math.abs(n) === 1 ? "" : "s"}`;

// How long since a start date: "2 years, 4 months", "5 months", "12 days"; "starts in 6 days" before it.
export function tenure(start: string, today: string): string {
  if (start > today) return `starts ${relativeDay(start, today)}`;
  const [sy, sm, sd] = start.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
  let months = (ty - sy) * 12 + (tm - sm) - (td < sd ? 1 : 0);
  const years = Math.floor(months / 12);
  months -= years * 12;
  if (years && months) return `${plural(years, "year")}, ${plural(months, "month")}`;
  if (years) return plural(years, "year");
  if (months) return plural(months, "month");
  return plural(daysBetween(start, today), "day");
}

// A value as text. Empty is "" (the table shows a dash); money_range reads "$90,000 – $120,000".
export function displayValue(column: ColumnLike, v: unknown, names: Names = {}, f: Formats = US): string {
  if (v === null || v === undefined || v === "") return "";
  const type = column.type === "computed" ? column.result ?? "text" : column.type;
  switch (type) {
    case "money":
      return typeof v === "number" ? formatMoney(v, f) : String(v);
    case "money_range": {
      const r = v as { from: number; to: number };
      return `${formatMoney(r.from, f)} – ${formatMoney(r.to, f)}`;
    }
    case "percent":
      return `${v}%`;
    case "days":
      return typeof v === "number" ? plural(v, "day") : String(v);
    case "number":
      return typeof v === "number" ? formatNumber(v, f) : String(v);
    case "date":
      return typeof v === "string" ? formatDate(v, f) : String(v);
    case "datetime":
      return typeof v === "string" ? `${formatDate(v, f)}, ${v.slice(11, 16)}` : String(v);
    case "choice":
      return column.options?.find((o) => o.id === v)?.name ?? "";
    case "step":
      return names.step?.(String(v)) ?? "";
    case "person":
      return names.person?.(String(v)) ?? "";
    case "link":
      return names.row?.(String(v)) ?? "";
    case "file":
      return names.file?.(String(v)) ?? "";
    default:
      return String(v);
  }
}
