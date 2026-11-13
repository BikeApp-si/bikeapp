import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { rows } from "@/db/schema";
import { formatDate } from "@/lib/format";
import { addToDate } from "./expr/evaluate";
import { KernelError, type CurrentFile, type Work } from "./context";
import { withToday } from "./compute";
import type { InForce } from "./expr/ast";
import { datedOf, type Sheet } from "./schema/file";
import { keptInForce } from "./dated-words";

// Dated sheets (0.5, M30): values kept by the date each starts (price lists, salaries, spending limits). For each key
// (a category, a product; or one series when the sheet has none) the row in force on a date is the one with the latest
// From on or before it. The kernel keeps each row's Until (the day before the next one for the same key starts), keeps
// one row per key and From, and keeps a row once it is in force: what applied on a past day never changes. A row still
// to come can be changed or deleted.

type Data = Record<string, unknown>;

const words = (sheet: Sheet) => sheet.row ?? { one: "row", many: "rows" };
const asDate = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

export { keptInForce };

// Whether a row has started: its From is today or earlier.
export const started = (sheet: Sheet, data: Data, today: string) => {
  const from = asDate(data[datedOf(sheet)!.from]);
  return !!from && from <= today;
};

// Before a row of a dated sheet is changed or deleted.
export function refuseInForce(w: Work, sheet: Sheet, data: Data) {
  if (datedOf(sheet) && started(sheet, data, w.today)) throw new KernelError(keptInForce(sheet));
}

const keyOf = (sheet: Sheet, data: Data): string | null => {
  const k = datedOf(sheet)!.key;
  const v = k ? data[k] : null;
  return v === null || v === undefined ? null : String(v);
};

// The rows of one key (or of the series), live.
const sameKey = (sheet: Sheet, key: string | null) => {
  const k = datedOf(sheet)!.key;
  return k ? (key === null ? sql`${rows.data}->>${k} is null` : sql`${rows.data}->>${k} = ${key}`) : undefined;
};

// One writer at a time per key, until the transaction ends, so two rows from the same day can't both be added.
async function lockKey(w: Work, capId: string, sheet: Sheet, key: string | null) {
  await w.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`dated:${capId}:${sheet.id}:${key ?? ""}`}))`);
}

// Before a row is added or changed: its key locked, one row per key and From, and a change can't start it in the past.
// keyName names the key in a refusal ("Meals").
export async function checkFrom(
  w: Work,
  capId: string,
  sheet: Sheet,
  data: Data,
  rowId: string | null,
  keyName: (key: string) => Promise<string>,
): Promise<void> {
  const d = datedOf(sheet);
  if (!d) return;
  const from = asDate(data[d.from]);
  if (!from) return; // required: checkValues has refused it already
  if (rowId && from <= w.today) throw new KernelError(`A ${words(sheet).one} can be changed only to start after today.`);
  const key = keyOf(sheet, data);
  await lockKey(w, capId, sheet, key);
  const [twin] = await w.tx
    .select({ id: rows.id })
    .from(rows)
    .where(and(eq(rows.capabilityId, capId), eq(rows.sheetId, sheet.id), isNull(rows.deletedAt), sameKey(sheet, key), sql`${rows.data}->>${d.from} = ${from}`, rowId ? ne(rows.id, rowId) : undefined))
    .limit(1);
  if (!twin) return;
  const when = formatDate(from, w.loaded.formats);
  throw new KernelError(d.key && key !== null ? `${await keyName(key)} already has a ${words(sheet).one} from ${when}.` : `There is already a ${words(sheet).one} from ${when}.`);
}

// Works out Until again for every row of these keys: the day before the next row's From, empty for the latest.
export async function setUntils(w: Work, capId: string, sheet: Sheet, keys: (string | null)[]): Promise<void> {
  const d = datedOf(sheet);
  if (!d) return;
  for (const key of new Set(keys)) {
    const list = await w.tx
      .select({ id: rows.id, data: rows.data })
      .from(rows)
      .where(and(eq(rows.capabilityId, capId), eq(rows.sheetId, sheet.id), isNull(rows.deletedAt), sameKey(sheet, key)))
      .orderBy(asc(sql`${rows.data}->>${d.from}`));
    for (const [i, r] of list.entries()) {
      const next = asDate((list[i + 1]?.data as Data | undefined)?.[d.from]);
      const until = next ? addToDate(next, -1, "days") : null;
      const data = r.data as Data;
      if ((data[d.until] ?? null) === until) continue;
      const after = { ...data };
      if (until) after[d.until] = until;
      else delete after[d.until];
      await w.tx.update(rows).set({ data: after }).where(eq(rows.id, r.id));
    }
  }
}

// After a write to a dated sheet: Until again for the keys it touched (both, when a row's key changed).
export async function afterWrite(w: Work, capId: string, sheet: Sheet, ...datas: (Data | undefined)[]) {
  if (!datedOf(sheet)) return;
  await setUntils(w, capId, sheet, datas.filter((x): x is Data => !!x).map((x) => keyOf(sheet, x)));
}

// An inForce, for one row: the value of the row in force on this row's date (or today), for this row's key.
export async function inForceOnRow(w: Work, cap: CurrentFile, f: InForce, data: Data): Promise<unknown> {
  const other = cap.file.sheets.find((s) => s.id === f.sheet);
  const d = other && datedOf(other);
  if (!other || !d) return null;
  const on = f.on ? asDate(data[f.on]) : w.today;
  if (!on) return null;
  let match = undefined;
  if (d.key) {
    const v = f.is ? data[f.is] : null;
    if (v === null || v === undefined) return null;
    match = sql`${rows.data}->>${d.key} = ${String(v)}`;
  }
  const [hit] = await w.tx
    .select({ data: rows.data })
    .from(rows)
    .where(and(eq(rows.capabilityId, cap.id), eq(rows.sheetId, other.id), isNull(rows.deletedAt), match, sql`${rows.data}->>${d.from} <= ${on}`))
    .orderBy(desc(sql`${rows.data}->>${d.from}`))
    .limit(1);
  // The row is read as it is read anywhere: with its own computed columns.
  return hit ? (withToday(other, hit.data as Data, w.today)[f.value] ?? null) : null;
}

// How a row of a dated sheet stands today: in force, still to come, or over.
export type DatedState = "now" | "later" | "past";
export function datedState(sheet: Sheet, data: Data, today: string): DatedState | undefined {
  const d = datedOf(sheet);
  if (!d) return undefined;
  const from = asDate(data[d.from]);
  const until = asDate(data[d.until]);
  if (!from || from > today) return "later";
  return until && until < today ? "past" : "now";
}
