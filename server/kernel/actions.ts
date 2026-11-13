import { and, eq, gte, sql } from "drizzle-orm";
import { auditEntries, people } from "@/db/schema";
import { capabilitiesFor } from "./capabilities";
import { accessTo } from "./access";
import { load, type KernelCtx } from "./context";
import type { Tx } from "./tx";
import { currentTime } from "./clock";

// Do it yourself (3a, 3a1, 12a): every sheet with an add action that the person's roles let them add to,
// plus Add a person for admins. Their most used in the last 90 days first (counted from the Audit log),
// then sidebar order. No AI.

export type Action = { label: string; capability: string; icon: string; color?: string; href: string };

const DAYS_90 = 90 * 86_400_000;

export async function doItYourself(tx: Tx, ctx: KernelCtx): Promise<Action[]> {
  const loaded = await load(tx);
  const found: (Action & { key: string })[] = [];
  for (const cap of await capabilitiesFor(tx, ctx)) {
    const access = await accessTo(tx, loaded, cap.id, ctx.actor.id);
    for (const sheet of access?.cap.file.sheets ?? []) {
      if (!sheet.addAction || sheet.kind === "lines" || !access!.can("add", sheet.id)) continue;
      found.push({ key: `${cap.id}:${sheet.name}`, label: sheet.addAction, capability: cap.name, icon: cap.icon, color: cap.color, href: `/c/${cap.id}?sheet=${sheet.id}&new=1` });
    }
  }
  const [me] = await tx.select({ isAdmin: people.isAdmin }).from(people).where(eq(people.id, ctx.actor.id));
  if (me?.isAdmin) found.push({ key: "person.added", label: "Add a person", capability: "People", icon: "users", href: "/people?new=1" });

  const since = new Date((ctx.now ?? currentTime()).getTime() - DAYS_90);
  const used = await tx
    .select({ event: auditEntries.event, cap: auditEntries.capabilityId, sheet: sql<string | null>`${auditEntries.details}->>'sheet'`, n: sql<number>`count(*)::int` })
    .from(auditEntries)
    .where(and(eq(auditEntries.who, ctx.actor.email), gte(auditEntries.at, since), sql`${auditEntries.event} in ('row.created', 'person.added')`))
    .groupBy(auditEntries.event, auditEntries.capabilityId, sql`${auditEntries.details}->>'sheet'`);
  const count = new Map(used.map((u) => [u.event === "person.added" ? "person.added" : `${u.cap}:${u.sheet}`, u.n]));

  // Stable sort: equal counts keep sidebar order.
  return found
    .map((a, i) => ({ a, i, n: count.get(a.key) ?? 0 }))
    .sort((x, y) => y.n - x.n || x.i - y.i)
    .map(({ a: { key: _key, ...action } }) => action);
}
