import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { proposals, rows, uploads, waits } from "@/db/schema";
import { accessTo, type Access } from "./access";
import { record } from "./audit";
import { checkAllocation, checkLimits, computeStored, recomputeBalances, recomputeDependents, withToday } from "./compute";
import { evaluateOn, withOtherRows } from "./env";
import { readsOtherRows } from "./expr/ast";
import { AccessError, KernelError, startWork, type CurrentFile, type KernelCtx, type Work } from "./context";
import type { Permission, Sheet } from "./schema/file";
import { allowedMoves, stepAllows, stepColumn, submitterOf } from "./steps";
import { filterSql, groupKeySql, groupOrderSql, orderSql, searchSql, summedColumns, type Filter, type GroupBy, type Sort } from "./query";
import { atomic, type Tx } from "./tx";
import { holds } from "./holds";
import { checkValue, checkValues, isEmptyValue, readsOtherRowsDefault, shown } from "./values";
import { flushRuleEntries, runRules, type WriteOpts, type Writers } from "./rules";
import { runChecks, type CheckResult } from "./checks";
import { checkNothingUnder, checkPlace, parentColumn, treeOrder } from "./tree";
import { accountOf, post, refuseChange, reversingValues } from "./ledger";
import { afterWrite, checkFrom, datedState, refuseInForce, started, type DatedState } from "./dated";
import { datedOf, ledgerOf } from "./schema/file";

// Rows: the only way data is written. Every write runs in the caller's transaction and does the same
// things in order: validate against the file → check access → apply and recompute → run the rules it
// triggers (rules.ts) → one Audit log entry, then the rules' entries. A deleted row is gone for every read:
// lists, single rows, links and sums. A rule's own writes skip the access check (its admin authorised it)
// and record no entry of their own: the rule's entry says what it did.

type Data = Record<string, unknown>;
export type RowView = {
  id: string;
  capabilityId: string;
  sheetId: string;
  data: Data;
  stepId: string | null;
  fileVersion: number;
  parentRowId: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  // A tree in its own order (M28): how far down the row sits (0 at the top), and whether rows sit under it.
  level?: number;
  branch?: boolean;
  // A ledger's entry another entry reverses (M29): shown "Reversed", and it can't be reversed again.
  reversed?: boolean;
  // A dated sheet's row (M30): in force today, still to come, or over. A row in force is kept as it is.
  dated?: DatedState;
};

const NOT_FOUND = "That row doesn't exist, or you can't see it.";
const CANT = "You can't do that here.";

// --- shared steps -----------------------------------------------------------------------------------------

async function accessFor(w: Work, capId: string): Promise<Access> {
  const a = await accessTo(w.tx, w.loaded, capId, w.ctx.actor.id);
  if (!a) throw new AccessError(NOT_FOUND);
  return a;
}

// A rule's write: the capability's file, with every permission (the access check is skipped, not passed).
function ruleAccess(w: Work, capId: string): Access {
  const cap = w.loaded.files.get(capId);
  if (!cap) throw new KernelError("That app no longer exists.");
  return { cap, roles: [], can: () => true, allows: async () => true, visible: () => sql`true` };
}

const accessOrRule = (w: Work, capId: string, opts: WriteOpts) => (opts.asRule ? Promise.resolve(ruleAccess(w, capId)) : accessFor(w, capId));

function sheetOf(cap: CurrentFile, sheetId: string): Sheet {
  const sheet = cap.file.sheets.find((s) => s.id === sheetId);
  if (!sheet) throw new KernelError(`${cap.file.name} has no such sheet.`);
  return sheet;
}

type LiveRow = NonNullable<Awaited<ReturnType<typeof liveRow>>>;
async function liveRow(w: Work, id: string, lock = false) {
  const q = w.tx.select().from(rows).where(and(eq(rows.id, id), isNull(rows.deletedAt)));
  const [row] = lock ? await q.for("update") : await q;
  return row ? { ...row, data: row.data as Data } : null;
}

// A row's name in the Audit log: its title column, with a person, choice or linked row written by name.
async function titleOf(w: Work, sheet: Sheet, data: Data, depth = 0): Promise<string> {
  const col = sheet.columns.find((c) => c.id === sheet.titleColumn);
  const v = data[sheet.titleColumn];
  if (col?.type === "person" && typeof v === "string") return w.loaded.people.get(v)?.name ?? "";
  if (col?.type === "choice") return col.options?.find((o) => o.id === v)?.name ?? "";
  if (col?.type === "link" && col.link && typeof v === "string" && depth < 2) {
    const target = await liveRow(w, v);
    const targetSheet = target && w.loaded.files.get(target.capabilityId)?.file.sheets.find((s) => s.id === target.sheetId);
    return target && targetSheet ? await titleOf(w, targetSheet, target.data, depth + 1) : "";
  }
  return isEmptyValue(v) ? "" : String(v);
}

// A value as the Audit log records it: plain numbers for money ("38400"), names for people, steps, choices
// and linked rows, the file's name for a file.
async function auditValue(w: Work, sheet: Sheet, c: Sheet["columns"][number], v: unknown): Promise<unknown> {
  if (isEmptyValue(v)) return null;
  switch (c.type) {
    case "money":
      return typeof v === "number" ? v / 100 : v;
    case "money_range": {
      const r = v as { from: number; to: number };
      return { from: r.from / 100, to: r.to / 100 };
    }
    case "person":
      return w.loaded.people.get(String(v))?.name ?? v;
    case "choice":
      return c.options?.find((o) => o.id === v)?.name ?? v;
    case "step":
      return sheet.steps?.find((s) => s.id === v)?.name ?? v;
    case "file": {
      const [f] = await w.tx.select({ name: uploads.name }).from(uploads).where(eq(uploads.id, String(v)));
      return f?.name ?? v;
    }
    case "link": {
      const target = await liveRow(w, String(v));
      const targetSheet = target && w.loaded.files.get(target.capabilityId)?.file.sheets.find((s) => s.id === target.sheetId);
      return target && targetSheet ? await titleOf(w, targetSheet, target.data) : v;
    }
    default:
      return v;
  }
}

// People, files and linked rows must exist; a link must point at a live row the person can see.
async function checkRefs(w: Work, cap: CurrentFile, sheet: Sheet, data: Data, changed: string[], asRule = false) {
  const errors: string[] = [];
  for (const id of changed) {
    const c = sheet.columns.find((col) => col.id === id);
    const v = data[id];
    if (!c || typeof v !== "string") continue;
    if (c.type === "person" && !w.loaded.people.has(v)) errors.push(`${c.name} must be someone in People.`);
    if (c.type === "file") {
      const [f] = await w.tx.select({ id: uploads.id }).from(uploads).where(eq(uploads.id, v));
      if (!f) errors.push(`${c.name} must be a file that was uploaded.`);
    }
    if (c.type === "link" && c.link) {
      const target = await liveRow(w, v);
      const targetCap = c.link.capability ?? cap.id;
      const ok =
        target &&
        target.capabilityId === targetCap &&
        target.sheetId === c.link.sheet &&
        (asRule || (await (await accessFor(w, targetCap).catch(() => null))?.allows("see", target)));
      if (!ok) errors.push(`${c.name} must be a row you can see.`);
    }
  }
  if (errors.length) throw new KernelError(errors[0]!, errors);
}

// known: the person already knows the row (it is new, or they just saw it), so a refusal can say so.
async function mustAllow(
  access: Access,
  perm: Permission,
  row: { sheetId: string; data: Data; parentRowId?: string | null },
  opts: { step?: string | null; known?: boolean } = {},
) {
  if (await access.allows(perm, row, opts.step)) return;
  // Someone who can't even see the row isn't told it exists.
  throw new AccessError(perm !== "see" && (opts.known || (await access.allows("see", row))) ? CANT : NOT_FOUND);
}

// Recompute the row's own computed columns, check allocations and limits, then the rows that total it.
async function applyComputed(w: Work, cap: CurrentFile, sheet: Sheet, id: string, data: Data, parentRowId: string | null, oldData?: Data) {
  const full = await computeStored(w, cap, sheet, id, data);
  if (sheet.kind === "allocation") await checkAllocation(w, cap, sheet, full, id);
  await w.tx.update(rows).set({ data: full }).where(eq(rows.id, id));
  await checkLimits(w, cap, sheet, id, full);
  await recomputeDependents(w, cap.id, sheet.id, { parentRowId, data: full, oldData });
  return full;
}

function view(w: Work, sheet: Sheet, row: typeof rows.$inferSelect): RowView {
  const dated = datedState(sheet, row.data as Data, w.today);
  return {
    ...(dated ? { dated } : {}),
    id: row.id,
    capabilityId: row.capabilityId,
    sheetId: row.sheetId,
    data: withToday(sheet, row.data as Data, w.today),
    stepId: row.stepId,
    fileVersion: row.fileVersion,
    parentRowId: row.parentRowId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// --- reads ------------------------------------------------------------------------------------------------

// Rows as read, with the computed columns that read other rows (Balance after) worked out now.
async function withLookups(w: Work, cap: CurrentFile, sheet: Sheet, list: RowView[]): Promise<RowView[]> {
  const marked = await withReversed(w, cap, sheet, list);
  if (!sheet.columns.some((c) => c.type === "computed" && c.expr && readsOtherRows(c.expr))) return marked;
  return Promise.all(marked.map(async (r) => ({ ...r, data: await withOtherRows(w, cap, sheet, r.id, r.data) })));
}

// A ledger's entries, each marked when another entry reverses it (M29).
async function withReversed(w: Work, cap: CurrentFile, sheet: Sheet, list: RowView[]): Promise<RowView[]> {
  const l = ledgerOf(sheet);
  if (!l || !list.length) return list;
  const found = await w.tx
    .select({ id: sql<string>`${rows.data}->>${l.reverses}` })
    .from(rows)
    .where(and(eq(rows.capabilityId, cap.id), eq(rows.sheetId, sheet.id), isNull(rows.deletedAt), sql`${rows.data}->>${l.reverses} in ${list.map((r) => r.id)}`));
  const reversed = new Set(found.map((f) => f.id));
  return list.map((r) => (reversed.has(r.id) ? { ...r, reversed: true } : r));
}

// only: these rows and no others (Waiting on me).
export type ListOpts = { parentRowId?: string; filters?: Filter[]; sort?: Sort; limit?: number; offset?: number; only?: string[]; search?: string; groupBy?: GroupBy };

const r = alias(rows, "r");

// The title column of a sheet, when it is stored text (for sorting by a link).
function titleColumnOf(loaded: Work["loaded"], capId: string) {
  return (sheetId: string, linkCap?: string) => {
    const sheet = loaded.files.get(linkCap ?? capId)?.file.sheets.find((s) => s.id === sheetId);
    const col = sheet?.columns.find((c) => c.id === sheet.titleColumn);
    return col && (col.type === "text" || col.type === "email") ? col.id : null;
  };
}

// The rows of a sheet this person can see, filtered and in the table's order (its sort, else as written).
// Lines can be limited to one document. limit and offset load a long sheet a part at a time.
export async function listRows(tx: Tx, ctx: KernelCtx, capId: string, sheetId: string, opts: ListOpts = {}): Promise<RowView[]> {
  const w = await startWork(tx, ctx);
  const access = await accessTo(tx, w.loaded, capId, ctx.actor.id);
  const sheet = access?.cap.file.sheets.find((s) => s.id === sheetId);
  const filter = access?.visible(sheetId, "r");
  if (!access || !sheet || !filter) return [];
  let q = tx
    .select()
    .from(r)
    .where(
      and(
        eq(r.capabilityId, capId),
        eq(r.sheetId, sheetId),
        isNull(r.deletedAt),
        opts.parentRowId ? eq(r.parentRowId, opts.parentRowId) : undefined,
        opts.only ? (opts.only.length ? inArray(r.id, opts.only) : sql`false`) : undefined,
        filter,
        filterSql(sheet, opts.filters ?? []),
        opts.search ? searchSql(sheet, opts.search, titleColumnOf(w.loaded, capId)) : undefined,
      ),
    )
    // Grouped (0.4): the group first, so each group's rows come together and paging keeps working.
    .orderBy(
      opts.groupBy
        ? sql`${groupOrderSql(sheet, opts.groupBy, titleColumnOf(w.loaded, capId))}, ${orderSql(sheet, opts.sort, titleColumnOf(w.loaded, capId))}`
        : orderSql(sheet, opts.sort, titleColumnOf(w.loaded, capId)),
    )
    .$dynamic();
  // A tree with no sort, filter or search reads as a tree: every row, put in order under its row above, then the part
  // asked for (M28).
  const parent = parentColumn(sheet);
  if (parent && !opts.sort && !opts.filters?.length && !opts.search && !opts.groupBy && !opts.only) {
    const all = treeOrder((await q).map((row) => view(w, sheet, row)), parent);
    const from = opts.offset ?? 0;
    return withLookups(w, access.cap, sheet, all.slice(from, opts.limit === undefined ? undefined : from + opts.limit));
  }
  if (opts.limit !== undefined) q = q.limit(opts.limit);
  if (opts.offset) q = q.offset(opts.offset);
  return withLookups(w, access.cap, sheet, (await q).map((row) => view(w, sheet, row)));
}

// How many rows match, and the totals of the sheet's money columns over all of them (6a's footer).
export async function sheetTotals(tx: Tx, ctx: KernelCtx, capId: string, sheetId: string, opts: { filters?: Filter[]; only?: string[]; search?: string } = {}) {
  const w = await startWork(tx, ctx);
  const access = await accessTo(tx, w.loaded, capId, ctx.actor.id);
  const sheet = access?.cap.file.sheets.find((s) => s.id === sheetId);
  const filter = access?.visible(sheetId, "r");
  if (!access || !sheet || !filter) return { count: 0, sums: {} as Record<string, number> };
  const summed = summedColumns(sheet);
  const [row] = await tx
    .select({
      n: sql<number>`count(*)::int`,
      ...Object.fromEntries(summed.map((c) => [c.id, sql<string | null>`sum((r.data->>${c.id})::numeric)`])),
    })
    .from(r)
    .where(
      and(
        eq(r.capabilityId, capId),
        eq(r.sheetId, sheetId),
        isNull(r.deletedAt),
        opts.only ? (opts.only.length ? inArray(r.id, opts.only) : sql`false`) : undefined,
        filter,
        filterSql(sheet, opts.filters ?? []),
        opts.search ? searchSql(sheet, opts.search, titleColumnOf(w.loaded, capId)) : undefined,
      ),
    );
  const got = (row ?? {}) as Record<string, unknown>;
  return { count: Number(got.n ?? 0), sums: Object.fromEntries(summed.map((c) => [c.id, Number(got[c.id] ?? 0)])) };
}

// A sheet's rows in groups (0.4, M20): each group's key and name, how many rows it has and its money subtotals, inside
// the person's access, in the groups' own order, with rows that have no value as one group last. The subtotals add up
// to `sheetTotals` for the same filters.
export type GroupTotal = { key: string | null; label: string; count: number; sums: Record<string, number> };

export async function groupTotals(tx: Tx, ctx: KernelCtx, capId: string, sheetId: string, opts: { filters?: Filter[]; search?: string; by: GroupBy }): Promise<GroupTotal[]> {
  const w = await startWork(tx, ctx);
  const access = await accessTo(tx, w.loaded, capId, ctx.actor.id);
  const sheet = access?.cap.file.sheets.find((s) => s.id === sheetId);
  const filter = access?.visible(sheetId, "r");
  if (!access || !sheet || !filter) return [];
  const col = sheet.columns.find((c) => c.id === opts.by.column)!;
  const key = groupKeySql(sheet, opts.by);
  const summed = summedColumns(sheet);
  const got = await tx
    .select({
      key: sql<string | null>`${key}`,
      n: sql<number>`count(*)::int`,
      ...Object.fromEntries(summed.map((c) => [c.id, sql<string | null>`sum((r.data->>${c.id})::numeric)`])),
    })
    .from(r)
    .where(
      and(
        eq(r.capabilityId, capId),
        eq(r.sheetId, sheetId),
        isNull(r.deletedAt),
        filter,
        filterSql(sheet, opts.filters ?? []),
        opts.search ? searchSql(sheet, opts.search, titleColumnOf(w.loaded, capId)) : undefined,
      ),
    )
    // By the first column selected: the key's parameters differ each time it is written, so Postgres can't match it.
    .groupBy(sql`1`);
  const keys = got.map((g) => g.key).filter((k): k is string => !!k);
  const names = new Map<string, string>();
  if (!opts.by.by && col.type === "person" && keys.length) for (const p of keys) names.set(p, w.loaded.people.get(p)?.name ?? "Someone");
  if (!opts.by.by && col.type === "link" && col.link && keys.length) {
    const title = titleColumnOf(w.loaded, capId)(col.link.sheet, col.link.capability);
    const linked = await tx.select({ id: rows.id, data: rows.data }).from(rows).where(inArray(rows.id, keys));
    for (const l of linked) names.set(l.id, String((l.data as Record<string, unknown>)[title ?? ""] ?? ""));
  }
  const options = col.type === "step" ? (sheet.steps ?? []) : col.type === "choice" ? (col.options ?? []) : [];
  const month = (k: string) => new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${k}-01T00:00:00Z`));
  const labelOf = (k: string) =>
    opts.by.by === "month" ? month(k) : opts.by.by === "team" ? k : (options.find((o) => o.id === k)?.name ?? names.get(k) ?? k);
  const out: GroupTotal[] = got.map((g) => ({
    key: g.key,
    label: g.key ? labelOf(g.key) : opts.by.by === "team" ? "No team" : `No ${col.name.toLowerCase()}`,
    count: Number(g.n),
    sums: Object.fromEntries(summed.map((c) => [c.id, Number((g as Record<string, unknown>)[c.id] ?? 0)])),
  }));
  const rank = (g: GroupTotal) => (options.length ? options.findIndex((o) => o.id === g.key) : 0);
  return out.sort((a, b) => {
    if (!a.key || !b.key) return a.key ? -1 : b.key ? 1 : 0;
    if (options.length) return rank(a) - rank(b);
    if (opts.by.by === "month") return a.key < b.key ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

// A board of a sheet's rows by step (0.4, M20): each step's count and its first rows, inside the person's access.
export async function boardRows(tx: Tx, ctx: KernelCtx, capId: string, sheetId: string, opts: { filters?: Filter[]; search?: string; perStep?: number; step?: string; offset?: number } = {}) {
  const w = await startWork(tx, ctx);
  const access = await accessTo(tx, w.loaded, capId, ctx.actor.id);
  const sheet = access?.cap.file.sheets.find((s) => s.id === sheetId);
  const stepCol = sheet && stepColumn(sheet);
  if (!access || !sheet || !stepCol || !access.can("see", sheetId)) throw new AccessError("That sheet doesn't exist, or you can't see it.");
  const counts = await groupTotals(tx, ctx, capId, sheetId, { filters: opts.filters, search: opts.search, by: { column: stepCol.id } });
  const steps = (sheet.steps ?? []).filter((st) => !opts.step || st.id === opts.step);
  const columns = [];
  for (const st of steps) {
    const list = await listRows(tx, ctx, capId, sheetId, { filters: [...(opts.filters ?? []), { column: stepCol.id, op: "in", values: [st.id] }], search: opts.search, limit: opts.perStep ?? 50, offset: opts.offset });
    columns.push({ step: st.id, count: counts.find((c) => c.key === st.id)?.count ?? 0, rows: list });
  }
  return columns;
}

export async function countRows(tx: Tx, ctx: KernelCtx, capId: string, sheetId: string, opts: { filters?: Filter[] } = {}): Promise<number> {
  return (await sheetTotals(tx, ctx, capId, sheetId, opts)).count;
}

export async function getRow(tx: Tx, ctx: KernelCtx, rowId: string): Promise<RowView> {
  const w = await startWork(tx, ctx);
  const row = await liveRow(w, rowId);
  if (!row) throw new AccessError(NOT_FOUND);
  const access = await accessFor(w, row.capabilityId);
  await mustAllow(access, "see", row);
  const sheet = sheetOf(access.cap, row.sheetId);
  return (await withLookups(w, access.cap, sheet, [view(w, sheet, row)]))[0]!;
}

// --- writes -----------------------------------------------------------------------------------------------

export type NewRow = { values: Data; parentRowId?: string | null };
// audit: false when the caller writes one entry for several writes. asImport: an import may set the step.
// newDocument: lines saved with a document created in the same call need no edit permission on it.
// asRule, level, quiet: a rule's write (rules.ts).
type Opts = WriteOpts;

// What the write's own entry adds about the rules it triggered in other capabilities.
const thenText = (elsewhere: string[]) => (elsewhere.length ? { then: elsewhere.join(" · ") } : {});

// Defaults that read another row (a candidate's Hiring manager from its opening, E1): worked out with the linked row
// as the row is added, before its access is checked, so a scope that reads the filled question sees it. A value the
// question can't hold is left empty; a required one left empty is refused as any other.
async function fillLinkedDefaults(w: Work, cap: CurrentFile, sheet: Sheet, data: Record<string, unknown>, missing?: string[]) {
  for (const c of sheet.columns) {
    if (!readsOtherRowsDefault(c) || !isEmptyValue(data[c.id]) || c.default?.kind !== "expr") continue;
    const v = await evaluateOn(w, cap, sheet, null, data, c.default.expr);
    const r = isEmptyValue(v) ? null : checkValue(c, v, sheet);
    if (r?.ok && !isEmptyValue(r.value)) data[c.id] = r.value;
    else if (c.required && !missing?.includes(c.id) && shown(c, data, w.today)) throw new KernelError(`${c.name} is required.`);
  }
}

async function create(w: Work, capId: string, sheetId: string, input: NewRow, opts: Opts = {}) {
  const access = await accessOrRule(w, capId, opts);
  const cap = access.cap;
  const sheet = sheetOf(cap, sheetId);

  // Lines belong to one document, and adding one is editing it.
  let parentRowId: string | null = null;
  if (sheet.kind === "lines") {
    const parent = input.parentRowId ? await liveRow(w, input.parentRowId) : null;
    if (!parent || parent.capabilityId !== capId || parent.sheetId !== sheet.parentSheet) throw new KernelError("A line must belong to a document.");
    if (!opts.newDocument) await mustAllow(access, "edit", parent);
    parentRowId = parent.id;
  } else if (input.parentRowId) throw new KernelError("Only lines belong to another row.");
  else if (!access.can("add", sheetId)) throw new AccessError(CANT);

  const checked = checkValues(sheet, input.values, {
    creatorId: opts.asRule ? null : w.ctx.actor.id,
    today: w.today,
    allowStep: opts.asImport,
    missing: opts.asImport ? opts.missing : undefined,
    kernel: opts.kernel,
  });
  if (!checked.ok) throw new KernelError(checked.errors[0]!, checked.errors);
  await checkRefs(w, cap, sheet, checked.data, Object.keys(checked.data), opts.asRule || opts.kernel);
  await fillLinkedDefaults(w, cap, sheet, checked.data, opts.asImport ? opts.missing : undefined);
  await checkPlace(w, capId, sheet, null, checked.data, (d) => titleOf(w, sheet, d));
  if (sheet.kind !== "lines") await mustAllow(access, "add", { sheetId, data: checked.data }, { known: true });
  // A ledger's entry: its balance after it, worked out with its account locked, and never below the lowest (M29).
  const values = await post(w, capId, sheet, checked.data, (id) => accountName(w, sheet, id));
  // A dated sheet's row: one per key and From (M30).
  await checkFrom(w, capId, sheet, values, null, (key) => keyName(w, sheet, key));

  const step = stepColumn(sheet);
  const [row] = await w.tx
    .insert(rows)
    .values({
      workspaceId: w.ctx.workspaceId,
      capabilityId: capId,
      sheetId,
      data: values,
      stepId: step ? ((values[step.id] as string) ?? null) : null,
      fileVersion: cap.version,
      parentRowId,
      createdBy: opts.asRule ? null : w.ctx.actor.id,
      imported: !!opts.asImport,
      createdAt: w.now,
      updatedAt: w.now,
    })
    .returning({ id: rows.id });
  await afterWrite(w, capId, sheet, values);
  const data = await applyComputed(w, cap, sheet, row!.id, datedOf(sheet) ? (await liveRow(w, row!.id))!.data : values, parentRowId);
  const account = ledgerOf(sheet) ? accountOf(sheet, data) : null;
  if (account) await recomputeBalances(w, cap, sheet, account);
  // A person's new row must pass the sheet's checks; imports and rules bring rows as they are.
  if (!opts.asImport && !opts.asRule && !opts.skipChecks) {
    const failed = (await runChecks(w, cap, sheet, row!.id, data)).filter((c) => !c.ok);
    if (failed.length) throw new KernelError(failed[0]!.reason!, failed.map((f) => f.reason!));
  }
  const ruleRow = { id: row!.id, capabilityId: capId, sheetId, data, createdBy: opts.asRule ? null : w.ctx.actor.id };
  const elsewhere = opts.asImport && opts.history ? [] : await runRules(w, { kind: "created", row: ruleRow }, WRITERS, { level: opts.level ?? 1, quiet: opts.quiet });
  if (opts.audit !== false)
    await record(w.tx, w.ctx, {
      who: w.ctx.actor.email,
      capabilityId: capId,
      event: "row.created",
      details: { sheet: sheet.name, row: await titleOf(w, sheet, data), by: "hand", ...thenText(elsewhere) },
      at: w.now,
      rows: [row!.id],
    });
  return { id: row!.id, data: (await liveRow(w, row!.id))!.data, sheet, elsewhere };
}

// The columns an import left empty on this row that someone still has to fill in.
async function importGaps(w: Work, rowId: string): Promise<string[]> {
  const open = await w.tx
    .select({ column: waits.untilColumn })
    .from(waits)
    .where(and(eq(waits.rowId, rowId), eq(waits.ruleSource, "import"), isNull(waits.clearedAt)));
  return [...new Set(open.map((o) => o.column).filter((c): c is string => !!c))];
}

async function update(w: Work, rowId: string, changes: Data, opts: Opts = {}) {
  const row = await liveRow(w, rowId, true);
  if (!row) throw new AccessError(NOT_FOUND);
  const access = await accessOrRule(w, row.capabilityId, opts);
  const cap = access.cap;
  const sheet = sheetOf(cap, row.sheetId);
  if (ledgerOf(sheet) || datedOf(sheet)) {
    await mustAllow(access, "see", row);
    refuseChange(sheet);
    refuseInForce(w, sheet, row.data);
  }
  await mustAllow(access, "edit", row);

  // Columns an import left empty for someone to fill in may stay empty while the others are filled.
  const gaps = await importGaps(w, rowId);
  const checked = checkValues(sheet, changes, { existing: row.data, creatorId: opts.asRule ? null : w.ctx.actor.id, today: w.today, missing: gaps });
  if (!checked.ok) throw new KernelError(checked.errors[0]!, checked.errors);
  const changed = sheet.columns.filter((c) => c.type !== "computed" && JSON.stringify(row.data[c.id] ?? null) !== JSON.stringify(checked.data[c.id] ?? null));
  if (!changed.length) return { id: rowId, data: row.data, sheet, changes: [], elsewhere: [] as string[] };
  await checkRefs(w, cap, sheet, checked.data, changed.map((c) => c.id), opts.asRule);
  if (changed.some((c) => c.id === parentColumn(sheet))) await checkPlace(w, cap.id, sheet, rowId, checked.data, (d) => titleOf(w, sheet, d));
  await checkFrom(w, cap.id, sheet, checked.data, rowId, (key) => keyName(w, sheet, key));
  // The row must still be theirs after the change.
  await mustAllow(access, "edit", { ...row, data: checked.data }, { known: true });

  await w.tx.update(rows).set({ data: checked.data, fileVersion: cap.version, updatedAt: w.now }).where(eq(rows.id, rowId));
  await afterWrite(w, cap.id, sheet, row.data, checked.data);
  const data = await applyComputed(w, cap, sheet, rowId, datedOf(sheet) ? (await liveRow(w, rowId))!.data : checked.data, row.parentRowId, row.data);
  const list = await Promise.all(
    changed.map(async (c) => ({ column: c.id, name: c.name, from: await auditValue(w, sheet, c, row.data[c.id]), to: await auditValue(w, sheet, c, data[c.id]) })),
  );
  // A wait for a column ends once it is filled (Your scorecard: the Score).
  const filled = changed.filter((c) => !isEmptyValue(data[c.id])).map((c) => c.id);
  if (filled.length)
    await w.tx.update(waits).set({ clearedAt: w.now }).where(and(eq(waits.rowId, rowId), isNull(waits.clearedAt), inArray(waits.untilColumn, filled)));
  const ruleRow = { id: rowId, capabilityId: cap.id, sheetId: sheet.id, data, createdBy: row.createdBy };
  const elsewhere = await runRules(w, { kind: "updated", row: ruleRow, changed: changed.map((c) => c.id) }, WRITERS, { level: opts.level ?? 1, quiet: opts.quiet });
  if (opts.audit !== false)
    await record(w.tx, w.ctx, {
      who: w.ctx.actor.email,
      capabilityId: cap.id,
      event: "row.updated",
      details: { sheet: sheet.name, row: await titleOf(w, sheet, data), changes: list, ...thenText(elsewhere) },
      at: w.now,
      rows: [rowId],
    });
  return { id: rowId, data: (await liveRow(w, rowId))!.data, sheet, changes: list, elsewhere };
}

async function move(w: Work, rowId: string, to: string, opts: Opts = {}) {
  const row = await liveRow(w, rowId, true);
  if (!row) throw new AccessError(NOT_FOUND);
  const access = await accessOrRule(w, row.capabilityId, opts);
  const cap = access.cap;
  const sheet = sheetOf(cap, row.sheetId);
  const col = stepColumn(sheet);
  if (!col) throw new KernelError(`${sheet.name} has no steps.`);
  const from = sheet.steps!.find((s) => s.id === row.data[col.id]);
  await mustAllow(access, "move_steps", row, { step: from?.id });
  const target = allowedMoves(sheet, row.data, w.today).find((s) => s.id === to);
  // A row waiting on someone else's decision stays where it is until they decide.
  if (!opts.asRule) {
    const [deciding] = await w.tx
      .select({ personId: waits.personId })
      .from(waits)
      .where(and(eq(waits.rowId, rowId), isNull(waits.clearedAt), isNotNull(waits.decision), ne(waits.personId, w.ctx.actor.id)));
    if (deciding) {
      const who = w.loaded.people.get(deciding.personId)?.name ?? "someone";
      throw new AccessError(`${(await titleOf(w, sheet, row.data)) || "This row"} is waiting on ${who} to decide.`);
    }
    // A row an import brought with required columns empty moves on once they are filled (4c).
    const empty = (await importGaps(w, rowId)).map((id) => sheet.columns.find((c) => c.id === id)?.name).filter(Boolean);
    if (empty.length) throw new KernelError(`${(await titleOf(w, sheet, row.data)) || "This row"} needs ${empty.join(" and ")} filled in before it moves on.`);
    // An AI step's suggestion waits to be confirmed or changed first (8h).
    const [suggested] = await w.tx.select({ columnId: proposals.columnId }).from(proposals).where(and(eq(proposals.rowId, rowId), eq(proposals.status, "waiting")));
    if (suggested) {
      const column = sheet.columns.find((c) => c.id === suggested.columnId)?.name ?? "value";
      throw new KernelError(`${(await titleOf(w, sheet, row.data)) || "This row"} has a suggested ${column} to confirm or change before it moves on.`);
    }
  }
  const step = target && !opts.asRule && stepAllows(from, target, submitterOf(sheet, row.data, row.createdBy), w.ctx.actor.id);
  if (step && !step.ok) {
    const title = (await titleOf(w, sheet, row.data)) || "This row";
    throw new AccessError(
      step.side === "in" ? `${title} is yours, so someone else moves it to ${target.name}.` : `Only the person who asked can move ${title} on from ${from?.name}.`,
    );
  }
  if (!target) {
    const name = sheet.steps!.find((s) => s.id === to)?.name;
    throw new KernelError(name ? `${(await titleOf(w, sheet, row.data)) || "This row"} can't move from ${from?.name} to ${name}.` : `${sheet.name} has no such step.`);
  }
  const data = { ...row.data, [col.id]: to };
  await w.tx.update(rows).set({ data, stepId: to, fileVersion: cap.version, updatedAt: w.now }).where(eq(rows.id, rowId));
  const full = await applyComputed(w, cap, sheet, rowId, data, row.parentRowId, row.data);
  // Waits at the step it left are over.
  await w.tx.update(waits).set({ clearedAt: w.now }).where(and(eq(waits.rowId, rowId), isNull(waits.clearedAt), isNotNull(waits.stepId), ne(waits.stepId, to)));
  const ruleRow = { id: rowId, capabilityId: cap.id, sheetId: sheet.id, data: full, createdBy: row.createdBy };
  const elsewhere = await runRules(w, { kind: "moved", row: ruleRow, to }, WRITERS, { level: opts.level ?? 1, quiet: opts.quiet });
  if (opts.audit !== false)
    await record(w.tx, w.ctx, {
      who: w.ctx.actor.email,
      capabilityId: cap.id,
      event: "row.step",
      details: { sheet: sheet.name, row: await titleOf(w, sheet, full), from: from?.name ?? null, to: target.name, ...thenText(elsewhere) },
      at: w.now,
      rows: [rowId],
    });
  return { id: rowId, data: (await liveRow(w, rowId))!.data, sheet, from: from?.id ?? null, to, elsewhere };
}

// A ledger's account by name, for a refusal: the person, or the linked row's title (M29).
async function accountName(w: Work, sheet: Sheet, id: string): Promise<string> {
  const col = sheet.columns.find((c) => c.id === ledgerOf(sheet)?.account);
  if (col?.type === "person") return w.loaded.people.get(id)?.name ?? "This person";
  const target = await liveRow(w, id);
  const targetSheet = target && w.loaded.files.get(target.capabilityId)?.file.sheets.find((s) => s.id === target.sheetId);
  return (target && targetSheet && (await titleOf(w, targetSheet, target.data))) || "This row";
}

// A row whose ledger entries would go with it can't be deleted: entries are only added (M29). Nor one whose rows of a
// dated sheet in force would (M30): what applied on a past day stays.
async function refuseEntriesGoing(w: Work, goingSheet: Sheet, cap: CurrentFile, from: { sheetId: string; data: Data }, going: Data) {
  const dated = datedOf(goingSheet) && started(goingSheet, going, w.today);
  if (!ledgerOf(goingSheet) && !dated) return;
  const title = (await titleOf(w, sheetOf(cap, from.sheetId), from.data)) || "This row";
  if (dated) throw new KernelError(`${title} has ${goingSheet.row?.many ?? goingSheet.name.toLowerCase()} already in force, so it can't be deleted.`);
  throw new KernelError(`${title} has ${goingSheet.row?.many ?? "entries"}, which are only added, so it can't be deleted.`);
}

// A dated sheet's key by name, for a refusal (M30): the choice, the person, the linked row's title, or the text.
async function keyName(w: Work, sheet: Sheet, key: string): Promise<string> {
  const col = sheet.columns.find((c) => c.id === datedOf(sheet)?.key);
  if (col?.type === "choice") return col.options?.find((o) => o.id === key)?.name ?? key;
  if (col?.type === "person") return w.loaded.people.get(key)?.name ?? "This person";
  if (col?.type === "link") {
    const target = await liveRow(w, key);
    const targetSheet = target && w.loaded.files.get(target.capabilityId)?.file.sheets.find((s) => s.id === target.sheetId);
    return (target && targetSheet && (await titleOf(w, targetSheet, target.data))) || "This row";
  }
  return key;
}

// Rows in the same capability that go with a deleted row: its lines and the rows that link to it. Not the rows of a
// tree under it: a row with rows under it can't be deleted (checkNothingUnder).
async function goesWith(w: Work, cap: CurrentFile, sheetId: string, rowId: string): Promise<string[]> {
  const linking = cap.file.sheets.flatMap((s) =>
    s.columns
      .filter((c) => c.type === "link" && c.link && !c.link.capability && !c.link.pick && c.link.sheet === sheetId && c.id !== parentColumn(s))
      .map((c) => ({ sheet: s.id, column: c.id })),
  );
  const found = await w.tx
    .select({ id: rows.id })
    .from(rows)
    .where(
      and(
        eq(rows.capabilityId, cap.id),
        isNull(rows.deletedAt),
        sql`(${rows.parentRowId} = ${rowId} or ${
          linking.length ? sql.join(linking.map((l) => sql`(${rows.sheetId} = ${l.sheet} and ${holds(l.column, rowId)})`), sql` or `) : sql`false`
        })`,
      ),
    );
  return found.map((r) => r.id);
}

// Rows in any app with a pick from a list pointing at a deleted row (G1): they stay, and that link is emptied.
type Emptied = { row: LiveRow; cap: CurrentFile; sheet: Sheet; columns: string[] };
async function pickedBy(w: Work, capId: string, sheetId: string, rowId: string, out: Map<string, Emptied>) {
  for (const cap of w.loaded.files.values())
    for (const s of cap.file.sheets)
      for (const c of s.columns) {
        if (c.type !== "link" || !c.link?.pick || c.link.sheet !== sheetId || (c.link.capability ?? cap.id) !== capId) continue;
        const found = await w.tx
          .select({ id: rows.id })
          .from(rows)
          .where(and(eq(rows.capabilityId, cap.id), eq(rows.sheetId, s.id), isNull(rows.deletedAt), holds(c.id, rowId)));
        for (const { id } of found) {
          const had = out.get(id);
          if (had) had.columns.push(c.id);
          else out.set(id, { row: (await liveRow(w, id, true))!, cap, sheet: s, columns: [c.id] });
        }
      }
}

// What a delete empties, worked out once everything going is known: rows that go themselves aren't emptied. An
// entry of a ledger, or a row of a dated sheet in force, is kept as it is, so the delete is refused.
async function toEmpty(w: Work, going: { row: LiveRow; cap: CurrentFile }[], gone: Set<string>) {
  const out = new Map<string, Emptied>();
  for (const { row, cap } of going) {
    const found = new Map<string, Emptied>();
    await pickedBy(w, cap.id, row.sheetId, row.id, found);
    for (const [id, e] of found) {
      if (gone.has(id)) continue;
      await refuseEntriesGoing(w, e.sheet, cap, row, e.row.data);
      const had = out.get(id);
      if (had) had.columns.push(...e.columns);
      else out.set(id, e);
    }
  }
  return [...out.values()];
}

async function empty(w: Work, list: Emptied[]) {
  for (const { row, cap, sheet, columns } of list) {
    const data = { ...row.data };
    for (const c of columns) delete data[c];
    await w.tx.update(rows).set({ data, fileVersion: cap.version, updatedAt: w.now }).where(eq(rows.id, row.id));
    await afterWrite(w, cap.id, sheet, row.data, data);
    await applyComputed(w, cap, sheet, row.id, data, row.parentRowId, row.data);
  }
}

async function remove(w: Work, rowIds: string[]) {
  const picked = [];
  for (const id of rowIds) {
    const row = await liveRow(w, id, true);
    if (!row) throw new AccessError(NOT_FOUND);
    const access = await accessFor(w, row.capabilityId);
    const sheet = sheetOf(access.cap, row.sheetId);
    if (ledgerOf(sheet) || datedOf(sheet)) {
      await mustAllow(access, "see", row);
      refuseChange(sheet);
      refuseInForce(w, sheet, row.data);
    }
    await mustAllow(access, sheet.kind === "lines" ? "edit" : "delete", row);
    picked.push({ row, cap: access.cap, sheet });
  }
  const deleting = new Set(rowIds);
  for (const p of picked) await checkNothingUnder(w, p.cap.id, p.sheet, p.row.id, p.row.data, deleting, (d) => titleOf(w, p.sheet, d));
  // Named before anything goes, so a title read through a link still finds it.
  const names = await Promise.all(picked.map((p) => titleOf(w, p.sheet, p.row.data)));
  const gone = new Set(rowIds);
  const queue = [...picked];
  const all = [...picked];
  while (queue.length) {
    const { row, cap } = queue.shift()!;
    for (const id of await goesWith(w, cap, row.sheetId, row.id)) {
      if (gone.has(id)) continue;
      gone.add(id);
      const r = (await liveRow(w, id, true))!;
      const item = { row: r, cap, sheet: sheetOf(cap, r.sheetId) };
      await refuseEntriesGoing(w, item.sheet, cap, row, r.data);
      queue.push(item);
      all.push(item);
    }
  }
  const emptied = await toEmpty(w, all, gone);
  await w.tx.update(rows).set({ deletedAt: w.now, updatedAt: w.now }).where(inArray(rows.id, [...gone]));
  for (const { row, cap, sheet } of all) {
    await afterWrite(w, cap.id, sheet, row.data);
    await recomputeDependents(w, cap.id, sheet.id, { parentRowId: row.parentRowId, data: row.data });
  }
  await empty(w, emptied);
  return { picked, names, alsoDeleted: all.length - picked.length, alsoEmptied: emptied.length };
}

// --- the kernel's row calls -------------------------------------------------------------------------------

// The writes rules make, through the same steps.
export const WRITERS: Writers = { create, update, move };

// After a call's own entry: the entries of the rules it ran.
export const flush = (w: Work) => flushRuleEntries(w, (e) => record(w.tx, w.ctx, e));

export async function createRow(tx: Tx, ctx: KernelCtx, capId: string, sheetId: string, input: NewRow) {
  return atomic(tx, async (tx) => {
    const w = await startWork(tx, ctx);
    const r = await create(w, capId, sheetId, input);
    await flush(w);
    return { id: r.id, data: r.data };
  });
}

export async function updateRow(tx: Tx, ctx: KernelCtx, rowId: string, changes: Data) {
  return atomic(tx, async (tx) => {
    const w = await startWork(tx, ctx);
    const r = await update(w, rowId, changes);
    await flush(w);
    return { id: r.id, data: r.data, changes: r.changes };
  });
}

export async function moveStep(tx: Tx, ctx: KernelCtx, rowId: string, stepId: string) {
  return atomic(tx, async (tx) => {
    const w = await startWork(tx, ctx);
    const r = await move(w, rowId, stepId);
    await flush(w);
    return { id: r.id, data: r.data };
  });
}

// Before a new row is added (8f, 8g): who it would wait on and why, and the sheet's checks, worked out by
// adding it for real inside a savepoint that is then rolled back. Nothing is kept.
export async function previewAdd(tx: Tx, ctx: KernelCtx, capId: string, sheetId: string, values: Data) {
  type Out = { goesTo: { id: string; name: string; why: string | null }[]; checks: CheckResult[]; problems: string[] };
  let out: Out = { goesTo: [], checks: [], problems: [] };
  await tx
    .transaction(async (tx) => {
      const w = await startWork(tx, ctx);
      try {
        const made = await create(w, capId, sheetId, { values }, { audit: false, skipChecks: true });
        const cap = w.loaded.files.get(capId)!;
        const asked = await tx.select({ personId: waits.personId, why: waits.why }).from(waits).where(and(eq(waits.rowId, made.id), isNull(waits.clearedAt)));
        // The why as the person adding it reads it: "your manager", when it is theirs.
        const mine = w.loaded.people.get(ctx.actor.id)?.name.split(" ")[0];
        out = {
          goesTo: asked.map((a) => ({ id: a.personId, name: w.loaded.people.get(a.personId)?.name ?? "", why: a.why === `you are ${mine}’s manager` ? "your manager" : null })),
          checks: await runChecks(w, cap, made.sheet, made.id, made.data),
          problems: [],
        };
      } catch (e) {
        if (!(e instanceof KernelError)) throw e;
        out = { goesTo: [], checks: [], problems: e.problems };
      }
      tx.rollback();
    })
    .catch((e) => (e instanceof Error && e.message === "Rollback" ? undefined : Promise.reject(e)));
  return out;
}

// The steps this person can move a row to from where it is now.
export async function movesFor(tx: Tx, ctx: KernelCtx, rowId: string) {
  const w = await startWork(tx, ctx);
  const row = await liveRow(w, rowId);
  if (!row) throw new AccessError(NOT_FOUND);
  const access = await accessFor(w, row.capabilityId);
  // A row this person can't see is refused, not answered with no moves: an empty answer would say it exists.
  await mustAllow(access, "see", row);
  const sheet = sheetOf(access.cap, row.sheetId);
  if (!(await access.allows("move_steps", row, row.stepId))) return [];
  const submitter = submitterOf(sheet, row.data, row.createdBy);
  const from = sheet.steps?.find((s) => s.id === row.stepId);
  return allowedMoves(sheet, row.data, w.today)
    .filter((s) => stepAllows(from, s, submitter, ctx.actor.id).ok)
    .map((s) => ({ id: s.id, name: s.name }));
}

// Deletes rows (and what goes with them in the same capability) as one change with one Audit entry.
export async function deleteRows(tx: Tx, ctx: KernelCtx, rowIds: string[]) {
  return atomic(tx, async (tx) => {
    if (!rowIds.length) return { deleted: 0, alsoDeleted: 0, alsoEmptied: 0 };
    const w = await startWork(tx, ctx);
    const { picked, names, alsoDeleted, alsoEmptied } = await remove(w, rowIds);
    const first = picked[0]!;
    await record(tx, ctx, {
      who: ctx.actor.email,
      capabilityId: first.cap.id,
      event: "row.deleted",
      details: { sheet: first.sheet.name, rows: names, alsoDeleted, ...(alsoEmptied ? { alsoEmptied } : {}) },
      at: w.now,
      rows: picked.map((p) => p.row.id),
    });
    return { deleted: picked.length, alsoDeleted, alsoEmptied };
  });
}

// Reverse (M29): a ledger's entry is corrected by an equal and opposite entry that points back to it, added by the
// kernel with the same checks as any entry (access to add, the lowest balance). Once per entry; a reversal can't be
// reversed. One Audit entry says what was reversed.
export async function reverseEntry(tx: Tx, ctx: KernelCtx, rowId: string) {
  return atomic(tx, async (tx) => {
    const w = await startWork(tx, ctx);
    const row = await liveRow(w, rowId, true);
    if (!row) throw new AccessError(NOT_FOUND);
    const access = await accessFor(w, row.capabilityId);
    const sheet = sheetOf(access.cap, row.sheetId);
    await mustAllow(access, "see", row);
    if (!ledgerOf(sheet)) throw new KernelError(`${sheet.name} isn't a ledger, so its rows aren't reversed.`);
    // Whoever may add an entry may reverse one; that is said before anything about the entry itself.
    if (!access.can("add", sheet.id)) throw new AccessError(CANT);
    const title = await titleOf(w, sheet, row.data);
    const values = await reversingValues(w, access.cap.id, sheet, row, title);
    const made = await create(w, access.cap.id, sheet.id, { values }, { audit: false, kernel: true, skipChecks: true });
    await record(tx, ctx, {
      who: ctx.actor.email,
      capabilityId: access.cap.id,
      event: "row.reversed",
      details: { sheet: sheet.name, row: title, by: await titleOf(w, sheet, made.data) },
      at: w.now,
      rows: [rowId, made.id],
    });
    await flush(w);
    return { id: made.id, data: made.data };
  });
}

// Select many (7d): the same change on several rows, as one change with one Audit entry listing the rows.
export async function bulkUpdate(tx: Tx, ctx: KernelCtx, rowIds: string[], change: { values: Data } | { step: string }) {
  return atomic(tx, async (tx) => {
    const w = await startWork(tx, ctx);
    const done = [];
    for (const id of rowIds) done.push("step" in change ? await move(w, id, change.step, { audit: false }) : await update(w, id, change.values, { audit: false }));
    const first = done[0];
    if (!first) return { updated: 0 };
    await record(tx, ctx, {
      who: ctx.actor.email,
      capabilityId: (await liveRow(w, first.id))!.capabilityId,
      event: "rows.bulk_updated",
      details: {
        sheet: first.sheet.name,
        rows: await Promise.all(done.map((d) => titleOf(w, d.sheet, d.data))),
        change: "step" in change ? { step: first.sheet.steps?.find((s) => s.id === change.step)?.name } : { columns: Object.keys(change.values) },
      },
      at: w.now,
      rows: done.map((d) => d.id),
    });
    await flush(w);
    return { updated: done.length };
  });
}

// Rows an import brings with required columns empty, and who fills them in (4c): each row waits on that
// person until its empty columns are filled, and can't move on before (an edit must leave no required
// column empty).
export type ImportGaps = { rows: { values: Data; missing: string[] }[]; personId: string; label: string };

// An import: rows at any step, all or nothing, with one Audit entry.
export async function importRows(
  tx: Tx,
  ctx: KernelCtx,
  capId: string,
  sheetId: string,
  input: NewRow[],
  // history: the rows come in as they were in the old system, starting no rules (a build, 4c).
  opts: { source: string; at?: Date; details?: Record<string, unknown>; changeSetId?: string; chatId?: string | null; gaps?: ImportGaps; history?: boolean },
) {
  return atomic(tx, async (tx) => {
    const w = await startWork(tx, { ...ctx, now: opts.at ?? ctx.now });
    const ids: string[] = [];
    const all = [...input.map((r) => ({ row: r, missing: [] as string[] })), ...(opts.gaps?.rows ?? []).map((g) => ({ row: { values: g.values }, missing: g.missing }))];
    if (opts.gaps && !w.loaded.people.has(opts.gaps.personId)) throw new KernelError("The person to fill those rows in isn't in People.");
    for (const [i, { row: r, missing }] of all.entries()) {
      try {
        // Rules run for waits and moves; notify sends no email from an import.
        const id = (await create(w, capId, sheetId, r, { audit: false, asImport: true, quiet: true, missing, history: opts.history })).id;
        ids.push(id);
        for (const column of missing)
          await tx.insert(waits).values({
            workspaceId: ctx.workspaceId,
            capabilityId: capId,
            rowId: id,
            personId: opts.gaps!.personId,
            ruleSource: "import",
            ruleId: opts.changeSetId ?? "import",
            stepId: null,
            untilColumn: column,
            label: opts.gaps!.label,
            why: null,
            createdAt: w.now,
          });
      } catch (e) {
        if (e instanceof KernelError) throw new KernelError(`Row ${i + 1}: ${e.message}`, e.problems.map((p) => `Row ${i + 1}: ${p}`));
        throw e;
      }
    }
    await record(tx, ctx, {
      who: ctx.actor.email,
      capabilityId: capId,
      event: "import.done",
      details: { file: opts.source, rows: ids.length, ...opts.details },
      changeSetId: opts.changeSetId,
      chatId: opts.chatId,
      at: w.now,
      rows: ids,
    });
    await flush(w);
    return ids;
  });
}

// A document and its lines, saved as one unit. Lines left out are deleted; a line can't move to another document.
export async function saveDocument(
  tx: Tx,
  ctx: KernelCtx,
  capId: string,
  sheetId: string,
  doc: { id?: string; values: Data },
  lines: { id?: string; values: Data }[],
) {
  return atomic(tx, async (tx) => {
    const w = await startWork(tx, ctx);
    const cap = (await accessFor(w, capId)).cap;
    const sheet = sheetOf(cap, sheetId);
    const linesSheet = cap.file.sheets.find((s) => s.kind === "lines" && s.parentSheet === sheetId);
    if (sheet.kind !== "document" || !linesSheet) throw new KernelError(`${sheet.name} isn't a document with lines.`);

    const saved = doc.id ? await update(w, doc.id, doc.values, { audit: false }) : await create(w, capId, sheetId, { values: doc.values }, { audit: false });
    const existing = await w.tx
      .select({ id: rows.id })
      .from(rows)
      .where(and(eq(rows.parentRowId, saved.id), eq(rows.sheetId, linesSheet.id), isNull(rows.deletedAt)));
    const mine = new Set(existing.map((r) => r.id));
    for (const line of lines) if (line.id && !mine.has(line.id)) throw new KernelError("A line can't move to another document.");
    const kept = new Set(lines.map((l) => l.id).filter(Boolean));
    const dropped = existing.map((r) => r.id).filter((id) => !kept.has(id));
    if (dropped.length) await remove(w, dropped);
    for (const line of lines) {
      if (line.id) await update(w, line.id, line.values, { audit: false });
      else await create(w, capId, linesSheet.id, { values: line.values, parentRowId: saved.id }, { audit: false, newDocument: !doc.id });
    }
    const final = (await liveRow(w, saved.id))!;
    await record(tx, ctx, {
      who: ctx.actor.email,
      capabilityId: capId,
      event: doc.id ? "row.updated" : "row.created",
      details: { sheet: sheet.name, row: await titleOf(w, sheet, final.data), lines: lines.length, ...(doc.id ? {} : { by: "hand" }) },
      at: w.now,
    });
    await flush(w);
    return { id: saved.id, data: withToday(sheet, final.data, w.today) };
  });
}

// Before Delete (7e): the rows by name, and how many rows go with them, per sheet ("Their 3 contacts").
export async function deletePreview(tx: Tx, ctx: KernelCtx, rowIds: string[]) {
  const w = await startWork(tx, ctx);
  const picked = [];
  const gone = new Set(rowIds);
  const also = new Map<string, { one: string; many: string; count: number }>();
  for (const id of rowIds) {
    const row = await liveRow(w, id);
    if (!row) throw new AccessError(NOT_FOUND);
    const access = await accessFor(w, row.capabilityId);
    const sheet = sheetOf(access.cap, row.sheetId);
    if (ledgerOf(sheet) || datedOf(sheet)) {
      await mustAllow(access, "see", row);
      refuseChange(sheet);
      refuseInForce(w, sheet, row.data);
    }
    await mustAllow(access, sheet.kind === "lines" ? "edit" : "delete", row);
    picked.push({ id, title: await titleOf(w, sheet, row.data), data: row.data, sheet, cap: access.cap });
  }
  for (const p of picked) await checkNothingUnder(w, p.cap.id, p.sheet, p.id, p.data, gone, (d) => titleOf(w, p.sheet, d));
  const queue = [...picked.map((p) => ({ id: p.id, sheetId: p.sheet.id, cap: p.cap }))];
  const going = [...queue];
  while (queue.length) {
    const { id, sheetId, cap } = queue.shift()!;
    for (const other of await goesWith(w, cap, sheetId, id)) {
      if (gone.has(other)) continue;
      gone.add(other);
      const r = (await liveRow(w, other))!;
      const s = sheetOf(cap, r.sheetId);
      const from = (await liveRow(w, id))!;
      await refuseEntriesGoing(w, s, cap, from, r.data);
      const words = s.row ?? { one: "row", many: "rows" };
      also.set(s.id, { ...words, count: (also.get(s.id)?.count ?? 0) + 1 });
      queue.push({ id: other, sheetId: r.sheetId, cap });
      going.push({ id: other, sheetId: r.sheetId, cap });
    }
  }
  // Rows that stay with a pick from a list emptied (G1), per sheet and column: "3 expenses stay, with Cost centre
  // left empty".
  const kept = new Map<string, { one: string; many: string; column: string; count: number }>();
  const goingRows = await Promise.all(going.map(async (g) => ({ row: (await liveRow(w, g.id, true))!, cap: g.cap })));
  for (const e of await toEmpty(w, goingRows, gone)) {
    const words = e.sheet.row ?? { one: "row", many: "rows" };
    for (const c of e.columns) {
      const key = `${e.cap.id}:${e.sheet.id}:${c}`;
      const column = e.sheet.columns.find((x) => x.id === c)?.name ?? c;
      kept.set(key, { ...words, column, count: (kept.get(key)?.count ?? 0) + 1 });
    }
  }
  return {
    rows: picked.map((p) => ({ id: p.id, title: p.title, data: p.data })),
    alsoDeleted: [...also.values()],
    alsoEmptied: [...kept.values()],
  };
}

// The steps every one of these rows can move to now (Move to step on 7d), in flow order.
export async function movesForAll(tx: Tx, ctx: KernelCtx, rowIds: string[]) {
  let common: { id: string; name: string }[] | null = null;
  for (const id of rowIds) {
    const moves = await movesFor(tx, ctx, id);
    common = common ? common.filter((m) => moves.some((x) => x.id === m.id)) : moves;
    if (!common.length) break;
  }
  return common ?? [];
}
