import { and, desc, eq, sql } from "drizzle-orm";
import { auditEntries, people, rowNotes } from "@/db/schema";
import { dayIn, formatDate, formatDay, formatMoney, type Formats } from "@/lib/format";
import { load, todayIn, type KernelCtx } from "./context";
import { getRow } from "./rows";
import type { Sheet } from "./schema/file";
import type { Tx } from "./tx";

// A row's own history (0.4, M22): the Audit entries that name it and its notes, newest first, for people who may see
// the row. Each change is a sentence the kernel writes from the entry's own fields about this row; what an entry says
// happened elsewhere is never shown, and a rule's sentence only to admins. Entries from before M22 don't name their
// rows, so such a row starts with "Created" from the row itself.

export type HistoryItem = { kind: "note" | "change"; at: string; when: string; who: string; whoId: string | null; text: string };

const AT_MOST = 200;

export async function rowHistory(tx: Tx, ctx: KernelCtx, rowId: string): Promise<HistoryItem[]> {
  const row = await getRow(tx, ctx, rowId); // refused when the person can't see it
  const loaded = await load(tx);
  const sheet = loaded.files.get(row.capabilityId)!.file.sheets.find((s) => s.id === row.sheetId)!;
  const everyone = await tx.select({ id: people.id, name: people.name, email: people.email, isAdmin: people.isAdmin }).from(people);
  const byEmail = new Map(everyone.map((p) => [p.email, p]));
  const admin = !!everyone.find((p) => p.id === ctx.actor.id)?.isAdmin;
  const when = whenIn(loaded.timeZone, todayIn(loaded.timeZone, ctx.now), loaded.formats);

  const entries = await tx
    .select()
    .from(auditEntries)
    .where(and(eq(auditEntries.workspaceId, ctx.workspaceId), sql`${auditEntries.rowIds} @> array[${rowId}]::uuid[]`))
    .orderBy(desc(auditEntries.at), desc(auditEntries.seq))
    .limit(AT_MOST);
  const notes = await tx.select().from(rowNotes).where(and(eq(rowNotes.workspaceId, ctx.workspaceId), eq(rowNotes.rowId, rowId))).orderBy(desc(rowNotes.createdAt)).limit(AT_MOST);

  const byId = new Map(notes.map((n) => [n.id, n]));
  const items: HistoryItem[] = [];
  // In the log's own order (time, then the order written), each note where its row.noted entry is.
  for (const e of entries) {
    const d = e.details as Record<string, unknown>;
    if (e.event === "row.noted") {
      const n = byId.get(String(d.note));
      const author = n && everyone.find((p) => p.id === n.authorId);
      if (n) items.push({ kind: "note", at: n.createdAt.toISOString(), when: when(n.createdAt), who: author?.name ?? "Someone", whoId: n.authorId, text: n.text });
      continue;
    }
    const person = byEmail.get(e.who);
    const who = person?.name ?? (e.who.startsWith("rule:") ? "A rule" : e.who.startsWith("ai_step:") ? "Bike" : (e.whoLabel ?? e.who));
    for (const text of sentences(sheet, e.event, d, { first: e.rowIds?.[0] === rowId, admin, fmt: loaded.formats })) items.push({ kind: "change", at: e.at.toISOString(), when: when(e.at), who, whoId: person?.id ?? null, text });
  }
  // A row from before rows were named in the log still says when it was made, and by whom.
  const addedByRepeat = (e: (typeof entries)[number]) => e.event === "rule.ran" && !!(e.details as Record<string, unknown> | null)?.on && e.rowIds?.[0] === rowId;
  if (!entries.some((e) => e.event === "row.created" || e.event === "import.done" || (e.event === "row.reversed" && e.rowIds?.[0] !== rowId) || addedByRepeat(e))) {
    const by = row.createdBy ? everyone.find((p) => p.id === row.createdBy) : undefined;
    items.push({ kind: "change", at: row.createdAt.toISOString(), when: when(row.createdAt), who: by?.name ?? "Bike", whoId: by?.id ?? null, text: "Created" });
  }
  return items;
}

// The sentences an entry says about this row: never its "then" (what happened in other capabilities).
export function sentences(sheet: Sheet, event: string, d: Record<string, unknown>, o: { first: boolean; admin: boolean; fmt: Formats }): string[] {
  switch (event) {
    case "row.created":
      return ["Created"];
    case "import.done":
      return [`Imported from ${String(d.file ?? "a file")}`];
    case "row.updated":
      return [((d.changes as { column: string; name: string; from: unknown; to: unknown }[]) ?? []).map((c) => `${c.name} ${shown(sheet, c.column, c.from, o.fmt)} → ${shown(sheet, c.column, c.to, o.fmt)}`).join(" · ")].filter(Boolean);
    case "row.step":
      return [d.from ? `Moved from ${String(d.from)} to ${String(d.to)}` : `Moved to ${String(d.to)}`];
    case "row.decided": {
      const [name, value] = Object.entries(d).find(([k]) => k !== "sheet" && k !== "row") ?? [];
      return name ? [`${name}: ${String(value)}`] : [];
    }
    case "rows.bulk_updated": {
      const change = d.change as { step?: string; columns?: string[] } | undefined;
      if (change?.step) return [`Moved to ${change.step}, with others`];
      const names = (change?.columns ?? []).map((id) => sheet.columns.find((c) => c.id === id)?.name ?? id);
      return [`${names.join(", ")} changed, with others`];
    }
    case "row.reversed": // M29: the entry, and the entry that reverses it
      return [o.first ? "Reversed" : `Created, reversing ${String(d.row ?? "an entry")}`];
    case "changeset.moved": // M27: "Customer, as typed → Customer, linked to Customers"
      return [String(d.change ?? "")].filter(Boolean);
    case "rule.ran": {
      // M32: a repeating rule added this row on a date of its schedule (m32-b).
      if (d.on && o.first) return [o.admin ? `Added: “${String(d.rule).replace(/\.$/, "")}”` : "Added by a rule"];
      if (o.admin) return [`“${String(d.rule)}”: ${String(d.did)}`];
      if (!o.first) return ["Changed by a rule"];
      // Only what it did to this row itself: its moves.
      return String(d.did ?? "")
        .split("; ")
        .filter((p) => p.startsWith("moved "))
        .map((p) => {
          const [from, to] = p.slice("moved ".length).split(" → ");
          return to ? `Moved from ${from} to ${to}` : `Moved to ${from}`;
        });
    }
    default:
      return [];
  }
}

// A value as the log keeps it (money in dollars, dates as YYYY-MM-DD, names as names), as people read it.
function shown(sheet: Sheet, columnId: string, v: unknown, fmt: Formats): string {
  if (v === null || v === undefined || v === "") return "—";
  const c = sheet.columns.find((x) => x.id === columnId);
  if (c?.type === "money" && typeof v === "number") return formatMoney(Math.round(v * 100), fmt);
  if ((c?.type === "date" || c?.type === "datetime") && typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return formatDate(v, fmt);
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

// "Oct 27, 4:12 PM" ("27 Oct, 4:12 PM" day first) in the company's time zone; the year too when it isn't this one.
export function whenIn(timeZone: string, today: string, fmt: Formats) {
  const year = today.slice(0, 4);
  return (at: Date) => {
    const day = dayIn(at, timeZone);
    const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(at);
    return `${day.slice(0, 4) === year ? formatDay(day, fmt) : formatDate(day, fmt)}, ${time}`;
  };
}
