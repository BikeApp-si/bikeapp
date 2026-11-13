import { morningEmails, outbox, people } from "@/db/schema";
import { startWork, type KernelCtx } from "./context";
import { waitingForEveryone, waitingForOne, type WaitingItem } from "./waiting";
import { unprime } from "./access";
import { atomic, type Tx } from "./tx";

// The morning email (8i): at 07:00 workspace time, each person with something waiting on them gets one email
// listing it, from the same query as the filter and the bubbles. Nothing on days with nothing. Written to the
// outbox in the transaction, at most once per person and day, and sent after it commits.

export type MorningItem = Pick<WaitingItem, "capabilityId" | "capability" | "sheetId" | "rowId" | "title" | "rowName" | "step" | "label" | "due">;

export async function queueMorningEmails(tx: Tx, ctx: KernelCtx): Promise<{ queued: number }> {
  return atomic(tx, async (tx) => {
    const w = await startWork(tx, ctx);
    const everyone = await tx.select({ id: people.id, email: people.email }).from(people).orderBy(people.seq);
    // What waits on everyone, read once; each person's list is then the same as their own Waiting on me (M12).
    const snapshot = await waitingForEveryone(w);
    const lists = new Map<string, MorningItem[]>();
    try {
      for (const p of everyone) {
        const items = await waitingForOne(w, p.id, snapshot);
        if (items.length) lists.set(p.id, items.map(({ capabilityId, capability, sheetId, rowId, title, rowName, step, label, due }) => ({ capabilityId, capability, sheetId, rowId, title, rowName, step, label, due })));
      }
    } finally {
      // The snapshot was true for this job only; nothing after it may read from it.
      unprime(w.loaded);
    }
    if (!lists.size) return { queued: 0 };
    // At most once per person and day: only those not yet emailed today get one, in People's order.
    const fresh = await tx
      .insert(morningEmails)
      .values([...lists].map(([personId, items]) => ({ workspaceId: ctx.workspaceId, personId, onDate: w.today, items: items.length, sentAt: w.now })))
      .onConflictDoNothing()
      .returning({ personId: morningEmails.personId });
    const now = new Set(fresh.map((f) => f.personId));
    const due = [...lists].filter(([personId]) => now.has(personId));
    if (due.length) await tx.insert(outbox).values(due.map(([personId, items]) => ({ workspaceId: ctx.workspaceId, personId, kind: "morning", payload: { date: w.today, items }, createdAt: w.now })));
    const queued = due.length;
    return { queued };
  });
}
