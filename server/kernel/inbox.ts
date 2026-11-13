import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { auditEntries, people, rowNotes, rows, waits } from "@/db/schema";
import { accessTo, type Access } from "./access";
import { startWork, type KernelCtx, type Work } from "./context";
import { sentences, whenIn } from "./history";
import type { Sheet } from "./schema/file";
import { submitterOf } from "./steps";
import type { Tx } from "./tx";
import { currentTime } from "./clock";
import { titleThrough, waitingFor, type WaitingItem } from "./waiting";

// The Inbox (0.5, M31), in three tabs, each only ever about rows the person may see now:
// - To do: Waiting on me, the same query as the bubbles and the morning email.
// - Waiting on others: the rows they sent that a rule asked someone else about, until that wait ends.
// - Updates: what others did to the rows they sent, are named in (a person column) or were asked about, read from
//   the Audit log as the row's own History reads it (a rule's sentence only to admins), newest first. Entries after
//   they last opened Updates are new. Their own changes are left out.

type Data = Record<string, unknown>;
type RowRead = typeof rows.$inferSelect;

export const toDo = (tx: Tx, ctx: KernelCtx): Promise<WaitingItem[]> => waitingFor(tx, ctx);

// Each capability's access for this person, read once per call.
function accessFor(w: Work) {
  const cache = new Map<string, Access | null>();
  return async (capId: string) => {
    if (!cache.has(capId)) cache.set(capId, await accessTo(w.tx, w.loaded, capId, w.ctx.actor.id));
    return cache.get(capId)!;
  };
}

// The row's sheet and the capability's access, when the person may see the row.
async function seen(w: Work, accessOf: ReturnType<typeof accessFor>, row: RowRead): Promise<{ a: Access; sheet: Sheet } | null> {
  const a = await accessOf(row.capabilityId);
  const sheet = a?.cap.file.sheets.find((s) => s.id === row.sheetId);
  if (!a || !sheet || !(await a.allows("see", { ...row, data: row.data as Data }))) return null;
  return { a, sheet };
}

// Who sent a row, for the Inbox (decided Nov 7): the person its creator column names; otherwise whoever added it,
// unless it came in through an import, which sends nothing (an admin moving data in isn't asking for anything).
function sentBy(sheet: Sheet, row: RowRead): string | null {
  const creator = sheet.columns.some((c) => c.type === "person" && c.default?.kind === "creator");
  if (creator) return submitterOf(sheet, row.data as Data, row.createdBy);
  return row.imported ? null : row.createdBy;
}

export type WaitingOnOthers = {
  capabilityId: string;
  capability: string;
  sheetId: string;
  rowId: string;
  title: string;
  on: string; // who it waits on
  label: string | null; // "Approve or decline"
  step: string | null;
  since: Date;
};

export async function waitingOnOthers(tx: Tx, ctx: KernelCtx): Promise<WaitingOnOthers[]> {
  const w = await startWork(tx, ctx);
  const me = ctx.actor.id;
  const accessOf = accessFor(w);
  const open = await tx
    .select({ wait: waits, row: rows })
    .from(waits)
    .innerJoin(rows, eq(rows.id, waits.rowId))
    .where(
      and(
        eq(rows.workspaceId, ctx.workspaceId),
        isNull(waits.clearedAt),
        isNull(rows.deletedAt),
        ne(waits.personId, me),
        // Rows they may have sent: added by them, or a column (the creator column) holding them; checked exactly below.
        sql`(${rows.createdBy} = ${me} or exists (select 1 from jsonb_each_text(${rows.data}) e where e.value = ${me}))`,
      ),
    )
    .orderBy(waits.createdAt, rows.seq);
  const items: WaitingOnOthers[] = [];
  for (const { wait, row } of open) {
    const s = await seen(w, accessOf, row);
    if (!s || sentBy(s.sheet, row) !== me) continue;
    items.push({
      capabilityId: row.capabilityId,
      capability: s.a.cap.file.name,
      sheetId: s.sheet.id,
      rowId: row.id,
      title: await titleThrough(w, s.a.cap, s.sheet, row.data as Data),
      on: w.loaded.people.get(wait.personId)?.name ?? "Someone",
      label: wait.label,
      step: s.sheet.steps?.find((x) => x.id === row.stepId)?.name ?? null,
      since: wait.createdAt,
    });
  }
  return items;
}

export type Update = {
  id: string; // the entry and the row, so one entry about two of their rows reads twice
  at: string;
  when: string;
  who: string;
  byRule: boolean;
  capabilityId: string;
  capability: string;
  sheetId: string;
  rowId: string;
  title: string;
  text: string;
  isNew: boolean;
};

const AT_MOST = 100;

// The newest entries, by others, on rows a person may be part of (sent, named in a person column, or asked about by a
// rule; an import is neither a change to report nor a way of sending), as (entry, row) pairs read newest first from
// the log, so a person who imported every row still reads only a page of it. Whether they are part of it, and may see
// it, is then checked row by row.
async function candidates(w: Work, email: string, limit: number) {
  const me = w.ctx.actor.id;
  const pairs = (await w.tx.execute(sql`
    select a.id as entry, u.row as row
    from audit_entries a
    cross join lateral unnest(a.row_ids) as u(row)
    join rows r on r.id = u.row and r.deleted_at is null
    where a.workspace_id = ${w.ctx.workspaceId} and a.row_ids is not null and a.who <> ${email} and a.event <> 'import.done'
      and ((r.created_by = ${me} and not r.imported)
        or exists (select 1 from jsonb_each_text(r.data) e where e.value = ${me})
        or exists (select 1 from waits x where x.row_id = r.id and x.person_id = ${me}))
    order by a.at desc, a.seq desc
    limit ${limit}`)) as unknown as { entry: string; row: string }[];
  return pairs;
}

// Of these rows, those the person is part of and may see now.
async function partOf(w: Work, rowIds: string[]) {
  const me = w.ctx.actor.id;
  const mine = new Map<string, { row: RowRead; sheet: Sheet; a: Access }>();
  if (!rowIds.length) return mine;
  const accessOf = accessFor(w);
  const asked = new Set((await w.tx.select({ id: waits.rowId }).from(waits).where(and(eq(waits.personId, me), inArray(waits.rowId, rowIds)))).map((r) => r.id));
  for (const row of await w.tx.select().from(rows).where(inArray(rows.id, rowIds))) {
    const s = await seen(w, accessOf, row);
    if (!s) continue;
    const data = row.data as Data;
    const named = s.sheet.columns.some((c) => c.type === "person" && data[c.id] === me);
    if (named || asked.has(row.id) || sentBy(s.sheet, row) === me) mine.set(row.id, { row, ...s });
  }
  return mine;
}

export async function updatesFor(tx: Tx, ctx: KernelCtx): Promise<Update[]> {
  const w = await startWork(tx, ctx);
  const me = w.loaded.people.get(ctx.actor.id);
  if (!me) return [];
  const pairs = await candidates(w, me.email, AT_MOST * 3); // some entries say nothing this person may read about their row
  if (!pairs.length) return [];
  const mine = await partOf(w, [...new Set(pairs.map((p) => p.row))]);
  const [person] = await tx.select({ seenAt: people.inboxSeenAt }).from(people).where(eq(people.id, me.id));
  const seenAt = person?.seenAt ?? null;
  const byEmail = new Map([...w.loaded.people.values()].map((p) => [p.email, p]));
  const when = whenIn(w.loaded.timeZone, w.today, w.loaded.formats);

  const byId = new Map((await tx.select().from(auditEntries).where(inArray(auditEntries.id, [...new Set(pairs.map((p) => p.entry))]))).map((e) => [e.id, e]));
  const entries = [...new Set(pairs.map((p) => p.entry))].map((id) => byId.get(id)!);
  const noteIds = entries.filter((e) => e.event === "row.noted").map((e) => String((e.details as Data).note));
  const notes = new Map(
    noteIds.length ? (await tx.select().from(rowNotes).where(inArray(rowNotes.id, noteIds))).map((n) => [n.id, n.text]) : [],
  );
  const titles = new Map<string, string>();

  const items: Update[] = [];
  for (const e of entries) {
    const d = e.details as Data;
    const person = byEmail.get(e.who);
    const byRule = e.who.startsWith("rule:");
    const who = person?.name ?? (byRule ? "A rule" : e.who.startsWith("ai_step:") ? "Bike" : (e.whoLabel ?? e.who));
    for (const rowId of e.rowIds ?? []) {
      const m = mine.get(rowId);
      if (!m) continue;
      const texts =
        e.event === "row.noted"
          ? [notes.get(String(d.note))].filter((t): t is string => !!t).map((t) => `“${t}”`)
          : sentences(m.sheet, e.event, d, { first: e.rowIds?.[0] === rowId, admin: me.isAdmin, fmt: w.loaded.formats });
      if (!texts.length) continue;
      if (!titles.has(rowId)) titles.set(rowId, await titleThrough(w, m.a.cap, m.sheet, m.row.data as Data));
      items.push({
        id: `${e.id}:${rowId}`,
        at: e.at.toISOString(),
        when: when(e.at),
        who,
        byRule,
        capabilityId: m.row.capabilityId,
        capability: m.a.cap.file.name,
        sheetId: m.sheet.id,
        rowId,
        title: titles.get(rowId)!,
        text: texts.join(" · "),
        isNew: !seenAt || e.at > seenAt,
      });
      if (items.length === AT_MOST) return items;
    }
  }
  return items;
}

// Opening Updates: what's there now is no longer new. Not an Audit entry (like a person's column choices).
export async function markUpdatesSeen(tx: Tx, ctx: KernelCtx): Promise<void> {
  await tx
    .update(people)
    .set({ inboxSeenAt: ctx.now ?? currentTime() })
    .where(and(eq(people.workspaceId, ctx.workspaceId), eq(people.id, ctx.actor.id)));
}
