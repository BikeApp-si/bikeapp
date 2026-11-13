import { forgetSetup } from "./setup-cache";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { auditEntries, capabilities, chats } from "@/db/schema";
import { detailsText } from "@/lib/audit-text";
import { toCsv } from "@/lib/csv";
import { formatUtc } from "@/lib/format";
import type { KernelCtx } from "./context";
import { mustBeAdmin } from "./admin";
import type { Ctx, Tx } from "./tx";
import { currentTime } from "./clock";

export type AuditInput = {
  who: string; // email, or rule:<id> / ai_step:<id>
  whoLabel?: string | null;
  event: string; // noun.verb, listed in docs/plan.md
  details?: Record<string, unknown>;
  capabilityId?: string | null;
  changeSetId?: string | null;
  chatId?: string | null;
  at?: Date; // now when left out; the seed sets the times the screens show
  rows?: string[]; // the rows it is about (0.4, M22): a row's History reads them back
};

// Append one Audit log entry inside the write's transaction.
export async function record(tx: Tx, ctx: Ctx, entry: AuditInput) {
  forgetSetup();
  await tx.insert(auditEntries).values({
    workspaceId: ctx.workspaceId,
    who: entry.who,
    whoLabel: entry.whoLabel ?? null,
    event: entry.event,
    details: entry.details ?? {},
    capabilityId: entry.capabilityId ?? null,
    changeSetId: entry.changeSetId ?? null,
    chatId: entry.chatId ?? null,
    rowIds: entry.rows?.length ? entry.rows : null,
    // One clock for every entry (clock.ts); the seq column keeps entries of the same millisecond in order.
    at: entry.at ?? currentTime(),
  });
}

// --- reading the log (9a): admins only, newest first, exactly as recorded ------------------------------------

export type AuditFilter = { search?: string; capabilityId?: string; who?: string };
export type AuditRow = { id: string; at: Date; who: string; capability: string | null; event: string; details: Record<string, unknown>; chatId: string | null };

function whereFor(f: AuditFilter): SQL | undefined {
  const q = f.search?.trim();
  return and(
    f.capabilityId ? eq(auditEntries.capabilityId, f.capabilityId) : undefined,
    f.who ? eq(auditEntries.who, f.who) : undefined,
    q
      ? sql`(${auditEntries.who} ilike ${like(q)} or ${auditEntries.event} ilike ${like(q)} or ${auditEntries.details}::text ilike ${like(q)} or ${capabilities.name} ilike ${like(q)})`
      : undefined,
  );
}
const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

export async function listAudit(tx: Tx, ctx: KernelCtx, f: AuditFilter & { limit?: number; offset?: number } = {}) {
  await mustBeAdmin(tx, ctx);
  const base = () => tx.select({ n: sql<number>`count(*)::int` }).from(auditEntries).leftJoin(capabilities, eq(capabilities.id, auditEntries.capabilityId));
  const [[all], [matching], entries] = await Promise.all([
    base(),
    base().where(whereFor(f)),
    tx
      .select({ id: auditEntries.id, at: auditEntries.at, who: auditEntries.who, capability: capabilities.name, event: auditEntries.event, details: auditEntries.details, chatId: chats.id })
      .from(auditEntries)
      .leftJoin(capabilities, eq(capabilities.id, auditEntries.capabilityId))
      // The chat an entry came from, when it is this admin's own (chats are seen only by their author, 12f).
      .leftJoin(chats, eq(chats.id, auditEntries.chatId))
      .where(whereFor(f))
      .orderBy(desc(auditEntries.at), desc(auditEntries.seq))
      .limit(f.limit ?? 100)
      .offset(f.offset ?? 0),
  ]);
  return { entries: entries as AuditRow[], matching: matching?.n ?? 0, total: all?.n ?? 0 };
}

// Who appears in the log, for the person filter.
export async function auditPeople(tx: Tx, ctx: KernelCtx): Promise<string[]> {
  await mustBeAdmin(tx, ctx);
  const rows = await tx.selectDistinct({ who: auditEntries.who }).from(auditEntries).orderBy(auditEntries.who);
  return rows.map((r) => r.who);
}

// Download CSV: every matching entry, with the same columns as the table.
export async function auditCsv(tx: Tx, ctx: KernelCtx, f: AuditFilter = {}): Promise<string> {
  const { entries } = await listAudit(tx, ctx, { ...f, limit: 100_000 });
  const lines = [["Time (UTC)", "Who", "App", "Event", "Details"], ...entries.map((e) => [formatUtc(e.at), e.who, e.capability ?? "—", e.event, detailsText(e.details)])];
  return toCsv(lines);
}
