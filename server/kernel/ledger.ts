import { and, eq, isNull, sql } from "drizzle-orm";
import { rows } from "@/db/schema";
import { formatMoney, formatNumber } from "@/lib/format";
import { holds } from "./holds";
import { KernelError, type CurrentFile, type Work } from "./context";
import { isBalanceOf, walk, type BalanceOf } from "./expr/ast";
import { ledgerOf, type Column, type Sheet } from "./schema/file";

// Ledgers (0.5, M29): entries are only added (leave taken and given, stock moves in and out). The kernel works out
// the balance after each entry as it is added, in the order entries come, one account at a time; refuses any change
// or delete; reverses a wrong entry with an equal and opposite one, once; and, when the ledger sets a lowest balance,
// refuses an entry that would take an account below it, whoever or whatever adds it.

type Data = Record<string, unknown>;

const words = (sheet: Sheet) => sheet.row ?? { one: "entry", many: "entries" };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Why an entry can't be changed or deleted.
export const onlyAdded = (sheet: Sheet) => `${cap(words(sheet).many)} are only added. To correct one, reverse it.`;

export function refuseChange(sheet: Sheet) {
  if (ledgerOf(sheet)) throw new KernelError(onlyAdded(sheet));
}

// The account an entry counts toward: a person's id or a linked row's id.
export const accountOf = (sheet: Sheet, data: Data): string | null => {
  const v = data[ledgerOf(sheet)!.account];
  return typeof v === "string" ? v : null;
};

// One writer at a time per account, until the transaction ends, so two entries added at once can't both read the
// same balance.
async function lockAccount(w: Work, capId: string, sheet: Sheet, account: string) {
  await w.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ledger:${capId}:${sheet.id}:${account}`}))`);
}

// An account's balance: its live entries' amounts added up.
export async function balanceFor(w: Work, capId: string, sheet: Sheet, account: string): Promise<number> {
  const l = ledgerOf(sheet)!;
  const [r] = await w.tx
    .select({ total: sql<string>`coalesce(sum((${rows.data}->>${l.amount})::numeric), 0)` })
    .from(rows)
    .where(and(eq(rows.capabilityId, capId), eq(rows.sheetId, sheet.id), isNull(rows.deletedAt), holds(l.account, account)));
  return Number(r?.total ?? 0);
}

function amountText(w: Work, column: Column | undefined, v: number) {
  if (column?.type === "money") return formatMoney(v, w.loaded.formats);
  if (column?.type === "days") return `${formatNumber(v, w.loaded.formats)} ${Math.abs(v) === 1 ? "day" : "days"}`;
  return formatNumber(v, w.loaded.formats);
}

// Before a new entry is written: lock its account, work out the balance after it, and refuse it if that goes below the
// ledger's lowest balance. Returns the entry's values with its balance.
export async function post(w: Work, capId: string, sheet: Sheet, data: Data, accountName: (id: string) => Promise<string>): Promise<Data> {
  const l = ledgerOf(sheet);
  if (!l) return data;
  const account = accountOf(sheet, data);
  if (!account) return data; // required: checkValues has refused it already
  await lockAccount(w, capId, sheet, account);
  const before = await balanceFor(w, capId, sheet, account);
  const amount = Number(data[l.amount] ?? 0);
  const after = before + amount;
  if (l.min !== undefined && amount < 0 && after < l.min) {
    const col = sheet.columns.find((c) => c.id === l.amount);
    const [name, has, takes] = [await accountName(account), amountText(w, col, before), amountText(w, col, -amount)];
    throw new KernelError(
      l.min === 0 ? `${name} has ${has}, so ${takes} can't be taken.` : `${name} has ${has} and can't go below ${amountText(w, col, l.min)}, so ${takes} can't be taken.`,
    );
  }
  return { ...data, [l.balance]: after };
}

// The entry reversing this one, if there is one.
export async function reversalOf(w: Work, capId: string, sheet: Sheet, entryId: string): Promise<string | null> {
  const [r] = await w.tx
    .select({ id: rows.id })
    .from(rows)
    .where(and(eq(rows.capabilityId, capId), eq(rows.sheetId, sheet.id), isNull(rows.deletedAt), holds(ledgerOf(sheet)!.reverses, entryId)))
    .limit(1);
  return r?.id ?? null;
}

// The values of the entry that reverses this one: the same account, the opposite amount, pointing back to it, and the
// other questions every entry must answer. Refused for a reversal, or an entry already reversed.
export async function reversingValues(w: Work, capId: string, sheet: Sheet, entry: { id: string; data: Data }, title: string): Promise<Data> {
  const l = ledgerOf(sheet)!;
  const { one } = words(sheet);
  if (typeof entry.data[l.reverses] === "string") throw new KernelError(`This ${one} reverses another, so it can't be reversed.`);
  const account = accountOf(sheet, entry.data);
  if (account) await lockAccount(w, capId, sheet, account);
  if (await reversalOf(w, capId, sheet, entry.id)) throw new KernelError(`${title || `This ${one}`} is already reversed.`);
  const values: Data = {};
  for (const c of sheet.columns) {
    if (c.id === l.balance || c.id === l.reverses || c.type === "computed") continue;
    if (c.id === l.account || c.required) values[c.id] = entry.data[c.id] ?? null;
  }
  values[l.amount] = -Number(entry.data[l.amount] ?? 0) || 0;
  values[l.reverses] = entry.id;
  const titleCol = sheet.columns.find((c) => c.id === sheet.titleColumn);
  if (titleCol?.type === "text" && title) values[titleCol.id] = `Reverses ${title}`.slice(0, 200);
  return values;
}

// Rows whose computed columns read this ledger's balance, and how each finds its account.
function readers(cap: CurrentFile, ledger: Sheet) {
  const out: { sheet: Sheet; of: string | undefined }[] = [];
  for (const sheet of cap.file.sheets) {
    const found = new Map<string, BalanceOf>();
    for (const c of sheet.columns) {
      if (c.type !== "computed" || !c.expr) continue;
      for (const n of walk(c.expr)) if (isBalanceOf(n) && n.balanceOf.sheet === ledger.id) found.set(n.balanceOf.of ?? "", n.balanceOf);
    }
    for (const b of found.values()) out.push({ sheet, of: b.of });
  }
  return out;
}

// The rows that show this account's balance: the linked row itself, or rows naming the account in a column.
export async function balanceReaders(w: Work, cap: CurrentFile, ledger: Sheet, account: string): Promise<{ sheet: Sheet; id: string }[]> {
  const out: { sheet: Sheet; id: string }[] = [];
  for (const r of readers(cap, ledger)) {
    const found = await w.tx
      .select({ id: rows.id })
      .from(rows)
      .where(and(eq(rows.capabilityId, cap.id), eq(rows.sheetId, r.sheet.id), isNull(rows.deletedAt), r.of ? holds(r.of, account) : eq(rows.id, account)));
    for (const f of found) out.push({ sheet: r.sheet, id: f.id });
  }
  return out;
}

// A balanceOf, for one row: the account is the row itself, or the value of one of its columns.
export async function balanceOnRow(w: Work, cap: CurrentFile, b: BalanceOf, rowId: string | null, data: Data): Promise<number> {
  const ledger = cap.file.sheets.find((s) => s.id === b.sheet);
  if (!ledger || !ledgerOf(ledger)) return 0;
  const account = b.of ? data[b.of] : rowId;
  return typeof account === "string" ? balanceFor(w, cap.id, ledger, account) : 0;
}
