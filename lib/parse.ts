import { formatDate, formatNumber, US, type Formats } from "./format";

// What a person types into a form field, turned into the value the kernel stores (and back). The kernel
// checks the value again when it is saved; this only reads the text.

export type Parsed = { ok: true; value: unknown } | { ok: false; error: string };
const ok = (value: unknown): Parsed => ({ ok: true, value });
const bad = (error: string): Parsed => ({ ok: false, error });

import { MONTHS as NAMED } from "./format";

const MONTHS = NAMED.map((m) => m.toLowerCase());
const pad = (n: number) => String(n).padStart(2, "0");

// "2025-11-15", "Nov 15, 2025" or "15 Nov 2025". Never 03/02/2025, which could be either day first or month first.
export function parseDate(text: string): string | null {
  const t = text.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  const named = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(t);
  const dayFirst = /^(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})$/i.exec(t);
  let y: number, m: number, d: number;
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (named) [y, m, d] = [Number(named[3]), MONTHS.indexOf(named[1]!.toLowerCase()) + 1, Number(named[2])];
  else if (dayFirst) [y, m, d] = [Number(dayFirst[3]), MONTHS.indexOf(dayFirst[2]!.toLowerCase()) + 1, Number(dayFirst[1])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (m < 1 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

const number = (text: string) => {
  // Any currency's sign is left out ("₹41,000", "€500"), as are separators in either grouping.
  const t = text.replace(/[\p{Sc},\s%]/gu, "");
  return t && /^-?\d*\.?\d+$/.test(t) ? Number(t) : null;
};

export function parseInput(type: string, text: string, name: string, f: Formats = US): Parsed {
  const t = text.trim();
  if (!t) return ok(null);
  switch (type) {
    case "money": {
      const n = number(t);
      return n === null ? bad(`${name} must be an amount, like 41,000.`) : ok(Math.round(n * 100));
    }
    case "money_range": {
      const [a, b] = t.split(/\s*(?:–|—|-|to)\s*/).map(number);
      return a == null || b == null ? bad(`${name} must be a range, like 90,000 – 120,000.`) : a > b ? bad(`${name} starts above where it ends.`) : ok({ from: Math.round(a * 100), to: Math.round(b * 100) });
    }
    case "number":
    case "percent": {
      const n = number(t);
      return n === null ? bad(`${name} must be a number.`) : ok(n);
    }
    case "days": {
      const n = number(t.replace(/\s*days?$/i, ""));
      return n === null || !Number.isInteger(n) ? bad(`${name} must be a whole number of days.`) : ok(n);
    }
    case "date": {
      const d = parseDate(t);
      return d ? ok(d) : bad(`${name} must be a date, like ${formatDate("2025-11-15", f)}.`);
    }
    case "datetime": {
      const m = /^(.+?)[,\s]+(\d{1,2}):(\d{2})$/.exec(t);
      const d = m && parseDate(m[1]!);
      return d ? ok(`${d}T${pad(Number(m![2]))}:${m![3]}:00.000Z`) : bad(`${name} must be a date and time, like ${formatDate("2025-11-15", f)} 14:30.`);
    }
    default:
      return ok(t);
  }
}

// A stored value as the text in its form field.
export function inputText(type: string, v: unknown, f: Formats = US): string {
  if (v === null || v === undefined) return "";
  switch (type) {
    case "money":
      return typeof v === "number" ? formatNumber(v / 100, f, { maximumFractionDigits: 2 }) : "";
    case "money_range": {
      const r = v as { from: number; to: number };
      return `${formatNumber(r.from / 100, f)} – ${formatNumber(r.to / 100, f)}`;
    }
    case "days":
      return `${v} days`;
    case "date":
      return typeof v === "string" ? formatDate(v, f) : "";
    case "datetime":
      return typeof v === "string" ? `${formatDate(v, f)} ${v.slice(11, 16)}` : "";
    default:
      return String(v);
  }
}

// Separators in a whole number: "1,234,567", or "12,34,567" in Indian grouping (M26).
function group(whole: string, grouping: Formats["grouping"]): string {
  if (grouping !== "indian" || whole.length <= 3) return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${whole.slice(-3)}`;
}

// An amount as it is typed (0.3): thousands separators added to each number, the rest kept as typed ("12000" →
// "12,000", "10000-20000" → "10,000-20,000"). caret: where the cursor was; given back where it belongs now, after the
// same digits and other characters (commas aren't counted).
export function formatMoneyTyping(text: string, caret: number, grouping: Formats["grouping"] = "standard"): { text: string; caret: number } {
  const plain = text.replace(/,/g, "");
  const before = text.slice(0, caret).replace(/,/g, "").length;
  const out = plain.replace(/\d+(\.\d*)?/g, (n) => {
    const [whole, cents] = n.split(".");
    return group(whole!, grouping) + (cents === undefined ? "" : `.${cents}`);
  });
  let seen = 0;
  let at = 0;
  while (at < out.length && seen < before) {
    if (out[at] !== ",") seen++;
    at++;
  }
  return { text: out, caret: at };
}
