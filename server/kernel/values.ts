import { readsOtherRows } from "./expr/ast";
import { evaluate } from "./expr/evaluate";
import { keptByKernel, type Column, type Sheet } from "./schema/file";

// Values as they are stored, by column type. The kernel takes and keeps these forms; forms convert what
// people type into them (M3).
//
//   text, long_text, email, phone, url   string
//   number, percent                      number      days    whole number
//   money                                whole cents money_range  { from, to } in cents
//   date                                 YYYY-MM-DD  datetime     ISO in UTC
//   person, file, link                   an id       choice, step an option or step id
//   computed                             worked out by the kernel, never written

export const MAX_TEXT = 500;
export const MAX_LONG_TEXT = 10_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9][0-9 ().-]{5,24}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isRealDate(v: string): boolean {
  const m = ISO_DATE.exec(v);
  if (!m) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() + 1 === Number(m[2]) && d.getUTCDate() === Number(m[3]);
}

export const isEmptyValue = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

type Checked = { ok: true; value: unknown } | { ok: false; error: string };
const ok = (value: unknown): Checked => ({ ok: true, value });
const bad = (error: string): Checked => ({ ok: false, error });

// One value against its column: the type, choices and limits. People, links and files are only checked for
// their shape here; that they exist (and can be seen) is checked against the database in rows.ts.
export function checkValue(column: Column, v: unknown, sheet?: Sheet): Checked {
  const n = column.name;
  if (isEmptyValue(v)) return ok(null);
  switch (column.type) {
    case "text":
    case "long_text": {
      if (typeof v !== "string") return bad(`${n} must be text.`);
      const max = column.type === "text" ? MAX_TEXT : MAX_LONG_TEXT;
      return v.length > max ? bad(`${n} is longer than ${max.toLocaleString("en-US")} characters.`) : ok(column.type === "text" ? v.trim() : v);
    }
    case "number":
    case "percent": {
      if (typeof v !== "number" || !Number.isFinite(v)) return bad(`${n} must be a number.`);
      if (column.min !== undefined && v < column.min) return bad(`${n} must be at least ${column.min}.`);
      if (column.max !== undefined && v > column.max) return bad(`${n} must be at most ${column.max}.`);
      return ok(v);
    }
    case "days":
      return Number.isSafeInteger(v) ? ok(v) : bad(`${n} must be a whole number of days.`);
    case "money":
      return Number.isSafeInteger(v) ? ok(v) : bad(`${n} must be an amount in cents.`);
    case "money_range": {
      const r = v as { from?: unknown; to?: unknown };
      if (typeof v !== "object" || !Number.isSafeInteger(r.from) || !Number.isSafeInteger(r.to)) return bad(`${n} must be a range from one amount to another.`);
      if ((r.from as number) > (r.to as number)) return bad(`${n} starts above where it ends.`);
      return ok({ from: r.from, to: r.to });
    }
    case "date":
      return typeof v === "string" && isRealDate(v) ? ok(v) : bad(`${n} must be a date.`);
    case "datetime": {
      const t = typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : NaN;
      return Number.isNaN(t) ? bad(`${n} must be a date and time.`) : ok(new Date(t).toISOString());
    }
    case "email":
      return typeof v === "string" && EMAIL.test(v.trim()) ? ok(v.trim().toLowerCase()) : bad(`${n} must be an email address.`);
    case "phone":
      return typeof v === "string" && PHONE.test(v.trim()) ? ok(v.trim()) : bad(`${n} must be a phone number.`);
    case "url": {
      if (typeof v !== "string") return bad(`${n} must be a web address.`);
      try {
        const u = new URL(/^https?:\/\//i.test(v.trim()) ? v.trim() : `https://${v.trim()}`);
        return u.hostname.includes(".") ? ok(v.trim()) : bad(`${n} must be a web address.`);
      } catch {
        return bad(`${n} must be a web address.`);
      }
    }
    case "person":
    case "file":
    case "link":
      return typeof v === "string" && UUID.test(v) ? ok(v.toLowerCase()) : bad(`${n} must be one ${column.type === "file" ? "file" : column.type === "person" ? "person" : "row"}.`);
    case "choice":
      return column.options?.some((o) => o.id === v) ? ok(v) : bad(`${n} must be one of ${column.options?.map((o) => o.name).join(", ")}.`);
    case "step":
      return sheet?.steps?.some((s) => s.id === v) ? ok(v) : bad(`${n} must be one of the sheet's steps.`);
    case "computed":
      return bad(`${n} is worked out by Bike and can't be filled in.`);
  }
}

// Whether a question is asked and shown for these values (0.3): always, unless its condition doesn't hold. Pure, so the
// form uses it as it is filled in, and the kernel on every save.
export function shown(column: Column, data: Record<string, unknown>, today: string): boolean {
  return !column.showWhen || evaluate(column.showWhen, { value: (c) => data[c], today }) === true;
}

export type ValuesCheck = { ok: true; data: Record<string, unknown> } | { ok: false; errors: string[] };

// A whole row's values. New rows get their defaults and are checked for required fields; an edit checks
// only what it changes but the result must still have every required field. Unknown columns are refused.
export function checkValues(
  sheet: Sheet,
  input: Record<string, unknown>,
  // missing: required columns an import may leave empty (rows waiting on someone to fill them, 4c).
  // kernel: the kernel's own values for the columns it keeps (a ledger's balance and reversal, M29).
  opts: { existing?: Record<string, unknown>; creatorId: string | null; today: string; allowStep?: boolean; missing?: string[]; kernel?: boolean },
): ValuesCheck {
  const errors: string[] = [];
  const data: Record<string, unknown> = { ...(opts.existing ?? {}) };
  const isNew = !opts.existing;

  for (const [id, raw] of Object.entries(input)) {
    const column = sheet.columns.find((c) => c.id === id);
    if (!column) {
      errors.push(`${sheet.name} has no column “${id}”.`);
      continue;
    }
    // Kept from before (M27): read only. A form that sends it back unchanged changes nothing.
    if (column.replacedBy) {
      const same = JSON.stringify(opts.existing?.[id] ?? null) === JSON.stringify(isEmptyValue(raw) ? null : raw);
      if (!same) errors.push(`${column.name} is kept from before and can't be changed.`);
      continue;
    }
    // Kept by the kernel (M29): a ledger's balance after each entry, and the entry a reversal reverses.
    if (keptByKernel(sheet, id) && !opts.kernel) {
      if (isEmptyValue(raw)) continue;
      errors.push(id === sheet.ledger?.reverses ? `${column.name} is filled in when an entry is reversed.` : `${column.name} is worked out by Bike.`);
      continue;
    }
    if (column.type === "step" && !opts.allowStep) {
      errors.push(`${column.name} changes by moving the row to a step.`);
      continue;
    }
    const r = checkValue(column, raw, sheet);
    if (r.ok) data[id] = r.value;
    else errors.push(r.error);
  }

  if (isNew) {
    for (const c of sheet.columns) {
      if (!isEmptyValue(data[c.id]) || !c.default || c.default.kind === "expr") continue;
      const d = c.default;
      data[c.id] = d.kind === "creator" ? opts.creatorId : d.kind === "today" ? opts.today : checkValue(c, d.value, sheet).ok ? d.value : null;
    }
    const step = sheet.columns.find((c) => c.type === "step");
    if (step && isEmptyValue(data[step.id])) data[step.id] = sheet.steps?.find((s) => s.start)?.id ?? null;
  }
  // Defaults worked out from other fields ("Start + 1 year") fill a field that is still empty. One that reads
  // another row ("the opening's hiring manager") is filled by the kernel with that row when the row is added (E1).
  for (const c of sheet.columns) {
    if (c.default?.kind !== "expr" || !isEmptyValue(data[c.id])) continue;
    if (!isNew && !(c.id in input)) continue;
    if (readsOtherRows(c.default.expr)) continue;
    const v = evaluate(c.default.expr, { value: (col) => data[col], today: opts.today });
    data[c.id] = isEmptyValue(v) ? null : v;
  }

  // A question that isn't shown (its condition doesn't hold) is never required; what it holds is kept.
  for (const c of sheet.columns)
    if (c.required && isEmptyValue(data[c.id]) && !opts.missing?.includes(c.id) && !(isNew && readsOtherRowsDefault(c)) && shown(c, data, opts.today))
      errors.push(`${c.name} is required.`);
  for (const k of Object.keys(data)) if (data[k] === null) delete data[k];
  return errors.length ? { ok: false, errors } : { ok: true, data };
}

// A default worked out from another row, filled when the row is added (rows.ts, E1).
export function readsOtherRowsDefault(c: Column): boolean {
  return c.default?.kind === "expr" && readsOtherRows(c.default.expr);
}
