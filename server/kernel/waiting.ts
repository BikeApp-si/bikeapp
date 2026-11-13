import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { displayValue } from "@/lib/format";
import { rows, waits } from "@/db/schema";
import { accessTo, memberKey, prime, primed, type Access } from "./access";
import { record } from "./audit";
import { AccessError, KernelError, startWork, type CurrentFile, type KernelCtx, type Work } from "./context";
import { flush, WRITERS } from "./rows";
import type { Sheet } from "./schema/file";
import { submitterOf } from "./steps";
import { atomic, type Tx } from "./tx";
import { findRule, rulesOn } from "./rule-set";

// Waiting on me: a row waits on a person only when something names them (brief › Waiting on me):
// - a rule asked them (ask_person), until the row leaves the step, the column is filled, or they decide;
// - or the row is at a step only its submitter may move it out of, and it is theirs (Needs a receipt).
// Being allowed to move a row is not enough. This one query gives the filter, the sidebar bubbles, the
// "N due" footer and the morning email, and it only ever lists rows the person can see.

type Data = Record<string, unknown>;

export type WaitingItem = {
  waitId: string | null; // null for a step only the submitter moves on
  capabilityId: string;
  capability: string;
  sheetId: string;
  rowId: string;
  title: string;
  rowName: string; // what a row of the sheet is called ("Interview")
  step: string | null;
  label: string | null; // "Your scorecard"; null for a step wait
  why: string | null;
  rule: string | null; // the rule's sentence
  decision: boolean;
  due: string | null; // the date the rule counted to, when it is a date rule
  at: Date;
};

const title = (w: Work, sheet: Sheet, data: Data) => {
  const col = sheet.columns.find((c) => c.id === sheet.titleColumn);
  const v = data[sheet.titleColumn];
  if (col?.type === "person" && typeof v === "string") return w.loaded.people.get(v)?.name ?? "";
  // An amount or a date as the company writes it (M26), not as stored.
  if (col && ["money", "money_range", "number", "date", "datetime"].includes(col.type)) return displayValue(col, v, {}, w.loaded.formats);
  return v === null || v === undefined ? "" : String(v);
};

// A row's title, reading through a link when the title is one (an interview is its candidate's name).
export async function titleThrough(w: Work, cap: CurrentFile, sheet: Sheet, data: Data): Promise<string> {
  const col = sheet.columns.find((c) => c.id === sheet.titleColumn);
  const v = data[sheet.titleColumn];
  if (col?.type !== "link" || !col.link || typeof v !== "string") return title(w, sheet, data);
  const seen = primed(w.loaded)?.rows;
  if (seen?.has(v)) {
    const t = seen.get(v);
    const other = t && w.loaded.files.get(t.capabilityId)?.file.sheets.find((s) => s.id === t.sheetId);
    return t && other ? title(w, other, t.data) : "";
  }
  const [target] = await w.tx.select().from(rows).where(and(eq(rows.id, v), isNull(rows.deletedAt)));
  const other = target && w.loaded.files.get(target.capabilityId)?.file.sheets.find((s) => s.id === target.sheetId);
  return target && other ? title(w, other, target.data as Data) : "";
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type RowRead = typeof rows.$inferSelect;
type Asked = { wait: typeof waits.$inferSelect; row: RowRead };

// What waits on everyone, read once for a job that asks for many people (the morning emails): every open wait with
// its row, in the order each person's own query would give; the rows held at submitter-only steps, per sheet; and,
// primed on the loaded setup, role members and the rows access and titles look through. itemsFor then gives each
// person exactly what it gives without it.
export type Everyone = { asked: Map<string, Asked[]>; held: Map<string, RowRead[]> };

const heldKey = (capId: string, sheetId: string) => `${capId}:${sheetId}`;
const heldSteps = (sheet: Sheet) => (sheet.steps ?? []).filter((s) => !s.end && s.moveOut === "submitter").map((s) => s.id);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function waitingForEveryone(w: Work): Promise<Everyone> {
  const asked = new Map<string, Asked[]>();
  const all = await w.tx
    .select({ wait: waits, row: rows })
    .from(waits)
    .innerJoin(rows, eq(rows.id, waits.rowId))
    .where(and(isNull(waits.clearedAt), isNull(rows.deletedAt)))
    .orderBy(asc(waits.createdAt), asc(rows.seq));
  for (const a of all) asked.set(a.wait.personId, [...(asked.get(a.wait.personId) ?? []), a]);

  const held = new Map<string, RowRead[]>();
  for (const cap of w.loaded.files.values())
    for (const sheet of cap.file.sheets) {
      const steps = heldSteps(sheet);
      if (!steps.length) continue;
      held.set(
        heldKey(cap.id, sheet.id),
        await w.tx
          .select()
          .from(rows)
          .where(and(eq(rows.capabilityId, cap.id), eq(rows.sheetId, sheet.id), isNull(rows.deletedAt), inArray(rows.stepId, steps)))
          .orderBy(asc(rows.seq)),
      );
    }

  // Who is in each role whose members come from a column: one query per role column, not one per person.
  const members = new Map<string, Set<string>>();
  for (const cap of w.loaded.files.values())
    for (const role of cap.file.roles) {
      const m = role.members;
      if (m.kind !== "column" || members.has(memberKey(cap.id, m.sheet, m.column))) continue;
      const found = await w.tx
        .selectDistinct({ id: sql<string | null>`${rows.data}->>${m.column}` })
        .from(rows)
        .where(and(eq(rows.capabilityId, cap.id), eq(rows.sheetId, m.sheet), isNull(rows.deletedAt)));
      members.set(memberKey(cap.id, m.sheet, m.column), new Set(found.map((f) => f.id).filter((id): id is string => !!id)));
    }

  // The rows access and titles look through: links in these rows' data, and lines' documents, in one query.
  const ids = new Set<string>();
  const note = (r: RowRead) => {
    if (r.parentRowId) ids.add(r.parentRowId);
    for (const v of Object.values(r.data as Data)) if (typeof v === "string" && UUID.test(v)) ids.add(v);
  };
  for (const list of asked.values()) for (const a of list) note(a.row);
  for (const list of held.values()) for (const r of list) note(r);
  const seen = new Map<string, { capabilityId: string; sheetId: string; data: Data } | null>([...ids].map((id) => [id, null]));
  if (ids.size)
    for (const r of await w.tx
      .select({ id: rows.id, capabilityId: rows.capabilityId, sheetId: rows.sheetId, data: rows.data })
      .from(rows)
      .where(and(inArray(rows.id, [...ids]), isNull(rows.deletedAt))))
      seen.set(r.id, { capabilityId: r.capabilityId, sheetId: r.sheetId, data: r.data as Data });
  prime(w.loaded, { members, rows: seen });
  return { asked, held };
}

async function itemsFor(w: Work, personId: string, capabilityId?: string, everyone?: Everyone): Promise<WaitingItem[]> {
  const access = new Map<string, Access | null>();
  const accessOf = async (capId: string) => {
    if (!access.has(capId)) access.set(capId, await accessTo(w.tx, w.loaded, capId, personId));
    return access.get(capId)!;
  };
  const items: WaitingItem[] = [];

  // Rows a rule asked them about.
  const asked = everyone
    ? (everyone.asked.get(personId) ?? [])
    : await w.tx
    .select({ wait: waits, row: rows })
    .from(waits)
    .innerJoin(rows, eq(rows.id, waits.rowId))
    .where(and(eq(waits.personId, personId), isNull(waits.clearedAt), isNull(rows.deletedAt), capabilityId ? eq(waits.capabilityId, capabilityId) : undefined))
    .orderBy(asc(waits.createdAt), asc(rows.seq));
  for (const { wait, row } of asked) {
    const a = await accessOf(row.capabilityId);
    const sheet = a?.cap.file.sheets.find((s) => s.id === row.sheetId);
    const data = row.data as Data;
    if (!a || !sheet || !(await a.allows("see", { ...row, data }))) continue;
    const rule = findRule(w.loaded.rules, wait.ruleSource, wait.ruleId)?.rule;
    const dateCol = rule?.trigger.kind === "date_reached" ? rule.trigger.date : undefined;
    const dateValue = dateCol ? data[dateCol] : undefined;
    items.push({
      waitId: wait.id,
      capabilityId: row.capabilityId,
      capability: a.cap.file.name,
      sheetId: sheet.id,
      rowId: row.id,
      title: await titleThrough(w, a.cap, sheet, data),
      rowName: capitalise(sheet.row?.one ?? "row"),
      step: sheet.steps?.find((s) => s.id === row.stepId)?.name ?? null,
      label: wait.label,
      why: wait.why,
      rule: rule?.text ?? null,
      decision: !!wait.decision,
      due: typeof dateValue === "string" ? dateValue.slice(0, 10) : null,
      at: wait.createdAt,
    });
  }

  // Rows at a step only their submitter moves on, when the row is theirs.
  for (const cap of w.loaded.files.values()) {
    if (capabilityId && cap.id !== capabilityId) continue;
    for (const sheet of cap.file.sheets) {
      const held = heldSteps(sheet);
      if (!held.length) continue;
      const a = await accessOf(cap.id);
      if (!a?.can("see", sheet.id)) continue;
      const found = everyone
        ? (everyone.held.get(heldKey(cap.id, sheet.id)) ?? [])
        : await w.tx
        .select()
        .from(rows)
        .where(and(eq(rows.capabilityId, cap.id), eq(rows.sheetId, sheet.id), isNull(rows.deletedAt), inArray(rows.stepId, held)))
        .orderBy(asc(rows.seq));
      for (const row of found) {
        const data = row.data as Data;
        if (submitterOf(sheet, data, row.createdBy) !== personId || !(await a.allows("see", { ...row, data }))) continue;
        items.push({
          waitId: null,
          capabilityId: cap.id,
          capability: cap.file.name,
          sheetId: sheet.id,
          rowId: row.id,
          title: title(w, sheet, data),
          rowName: capitalise(sheet.row?.one ?? "row"),
          step: sheet.steps?.find((s) => s.id === row.stepId)?.name ?? null,
          label: null,
          why: null,
          rule: null,
          decision: false,
          due: null,
          at: row.updatedAt,
        });
      }
    }
  }
  return items;
}

export async function waitingFor(tx: Tx, ctx: KernelCtx, opts: { capabilityId?: string } = {}): Promise<WaitingItem[]> {
  return itemsFor(await startWork(tx, ctx), ctx.actor.id, opts.capabilityId);
}

// The same, for one person among everyone, from a snapshot read once (the morning emails).
export const waitingForOne = (w: Work, personId: string, everyone: Everyone) => itemsFor(w, personId, undefined, everyone);

// The sidebar's bubbles: how many rows wait on this person in each capability.
export async function waitingCounts(tx: Tx, ctx: KernelCtx): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const i of await waitingFor(tx, ctx)) counts[i.capabilityId] = (counts[i.capabilityId] ?? 0) + 1;
  return counts;
}

export type RowWaits = { mine: WaitingItem[]; others: string[] };

// For a sheet's rows: what waits on this person, and on whom else (first names), including what waits on rows
// that point at them one link away in the same capability (an interview waits on its candidate's row).
export async function waitsOnRows(tx: Tx, ctx: KernelCtx, capId: string, sheetId: string, rowIds: string[]): Promise<Record<string, RowWaits>> {
  const w = await startWork(tx, ctx);
  const cap = w.loaded.files.get(capId);
  const out: Record<string, RowWaits> = Object.fromEntries(rowIds.map((id) => [id, { mine: [], others: [] }]));
  if (!cap || !rowIds.length) return out;
  const pointing = cap.file.sheets.flatMap((s) => s.columns.filter((c) => c.type === "link" && c.link && !c.link.capability && c.link.sheet === sheetId).map((c) => ({ sheet: s.id, column: c.id })));
  // Each waiting row, and the row of this sheet it shows on.
  const shownOn = new Map<string, string>(rowIds.map((id) => [id, id]));
  if (pointing.length) {
    const linked = await tx
      .select({ id: rows.id, data: rows.data, sheetId: rows.sheetId })
      .from(rows)
      .where(
        and(
          eq(rows.capabilityId, capId),
          isNull(rows.deletedAt),
          sql`(${sql.join(pointing.map((p) => sql`(${rows.sheetId} = ${p.sheet} and ${rows.data}->>${p.column} in (${sql.join(rowIds.map((id) => sql`${id}`), sql`, `)}))`), sql` or `)})`,
        ),
      );
    for (const l of linked) {
      const p = pointing.find((x) => x.sheet === l.sheetId)!;
      shownOn.set(l.id, String((l.data as Data)[p.column]));
    }
  }
  for (const item of await itemsFor(w, ctx.actor.id, capId)) {
    const on = shownOn.get(item.rowId);
    if (on) out[on]!.mine.push(item);
  }
  // Others: only rows this person can see already (the caller listed them), named by first name.
  const theirs = await tx
    .select({ rowId: waits.rowId, personId: waits.personId })
    .from(waits)
    .where(and(eq(waits.capabilityId, capId), isNull(waits.clearedAt), inArray(waits.rowId, [...shownOn.keys()])))
    .orderBy(asc(waits.createdAt));
  for (const t of theirs) {
    if (t.personId === ctx.actor.id) continue;
    const on = out[shownOn.get(t.rowId)!]!;
    const first = w.loaded.people.get(t.personId)?.name.split(" ")[0];
    if (first && !on.others.includes(first)) on.others.push(first);
  }
  return out;
}

// Why a row waits on this person, as the record panel says it (X1), or null when it doesn't.
export async function reasonFor(tx: Tx, ctx: KernelCtx, rowId: string): Promise<string | null> {
  return (await rowWait(tx, ctx, rowId))?.reason ?? null;
}

// The rows of a sheet that wait on this person (the Waiting on me filter), including those an item on a row
// one link away shows on.
export async function waitingRowIds(tx: Tx, ctx: KernelCtx, capId: string, sheetId: string): Promise<string[]> {
  const w = await startWork(tx, ctx);
  const cap = w.loaded.files.get(capId);
  if (!cap) return [];
  const ids = new Set<string>();
  for (const item of await itemsFor(w, ctx.actor.id, capId)) {
    if (item.sheetId === sheetId) {
      ids.add(item.rowId);
      continue;
    }
    const link = cap.file.sheets.find((s) => s.id === item.sheetId)?.columns.find((c) => c.type === "link" && c.link && !c.link.capability && c.link.sheet === sheetId);
    if (!link) continue;
    const [row] = await tx.select({ data: rows.data }).from(rows).where(eq(rows.id, item.rowId));
    const to = (row?.data as Data | undefined)?.[link.id];
    if (typeof to === "string") ids.add(to);
  }
  return [...ids];
}

// What waits on this person in one row: the reason the panel shows, and the wait to decide on when they are
// asked for a decision.
export async function rowWait(tx: Tx, ctx: KernelCtx, rowId: string): Promise<{ reason: string; decisionWaitId: string | null } | null> {
  const w = await startWork(tx, ctx);
  const [row] = await tx.select().from(rows).where(and(eq(rows.id, rowId), isNull(rows.deletedAt)));
  if (!row) return null;
  const items = (await itemsFor(w, ctx.actor.id, row.capabilityId)).filter((i) => i.rowId === rowId);
  const item = items[0];
  if (!item) return null;
  const cap = w.loaded.files.get(row.capabilityId)!;
  const sheet = cap.file.sheets.find((s) => s.id === row.sheetId)!;
  if (!item.waitId) return { reason: `Waiting on you because only the person who asked moves it on from ${item.step}.`, decisionWaitId: null };
  const because = item.why ? ` because ${item.why}` : "";
  const ruleText = item.rule ? ` Rule: “${item.rule.replace(/\.$/, "")}.”` : "";
  // Who the rules email once it leaves this step.
  const data = row.data as Data;
  const told = new Set<string>();
  for (const { rule: r } of rulesOn(w.loaded.rules, cap.id, sheet.id)) {
    if (!r.enabled || r.trigger.kind !== "enters_step" || r.trigger.step === row.stepId) continue;
    for (const a of r.actions) {
      if (a.kind !== "notify") continue;
      for (const id of [...(a.columns ?? []).map((c) => data[c]), ...(a.people ?? [])]) if (typeof id === "string" && id !== ctx.actor.id) told.add(id);
    }
  }
  const names = [...told].map((id) => w.loaded.people.get(id)?.name.split(" ")[0]).filter(Boolean) as string[];
  const emailed = names.length ? ` ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are` : `${names[0]} is`} emailed when you decide.` : "";
  return { reason: `Waiting on you${because}.${ruleText}${emailed}`, decisionWaitId: item.decision ? item.waitId : null };
}

// Approve or Decline, when a rule asked this person to decide. The decision is written to the row's choice
// column, the wait ends, and the rules that watch that column run.
export async function decide(tx: Tx, ctx: KernelCtx, waitId: string, choice: "approve" | "decline") {
  return atomic(tx, async (tx) => {
    const w = await startWork(tx, ctx);
    const [wait] = await tx.select().from(waits).where(and(eq(waits.id, waitId), isNull(waits.clearedAt))).for("update");
    const d = wait?.decision as { column: string; approve: string; decline: string } | null | undefined;
    if (!wait || wait.personId !== ctx.actor.id) throw new AccessError("That isn't waiting on you.");
    if (!d) throw new KernelError("That doesn't ask for a decision.");
    const cap = w.loaded.files.get(wait.capabilityId);
    const [row] = await tx.select().from(rows).where(and(eq(rows.id, wait.rowId), isNull(rows.deletedAt)));
    const sheet = row && cap?.file.sheets.find((s) => s.id === row.sheetId);
    if (!row || !cap || !sheet) throw new AccessError("That row doesn't exist, or you can't see it.");
    const option = d[choice];
    await tx.update(waits).set({ clearedAt: w.now, decided: option, decidedBy: ctx.actor.id }).where(eq(waits.id, waitId));
    // Written with the rule's authority: the person was asked, whatever their role.
    await WRITERS.update(w, row.id, { [d.column]: option }, { audit: false, asRule: true, level: 1 });
    const col = sheet.columns.find((c) => c.id === d.column);
    await record(tx, ctx, {
      who: ctx.actor.email,
      capabilityId: cap.id,
      event: "row.decided",
      details: { sheet: sheet.name, row: title(w, sheet, row.data as Data), [col?.name ?? d.column]: col?.options?.find((o) => o.id === option)?.name ?? option },
      at: w.now,
      rows: [row.id],
    });
    await flush(w);
    return { rowId: row.id, decided: option };
  });
}

