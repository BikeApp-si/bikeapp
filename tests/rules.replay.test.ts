// Done when (M4): the seeded Fernwood rules replay the same on every run. The six capabilities are seeded into
// two fresh workspaces, each replaying the daily job day by day to Oct 27, and everything the rules wrote is
// compared with ids replaced by names: rows, waits, rule runs, the outbox and the Audit log.
import { describe, expect, it } from "vitest";
import { asc } from "drizzle-orm";
import { auditEntries, capabilities, outbox, people, ruleRuns, rows, uploads, waits } from "@/db/schema";
import { seedWorkspace } from "@/seed";
import { seedCapabilities } from "@/seed/capabilities";
import { FERNWOOD, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES } from "@/seed/fernwood";
import { runDateRules, systemCtx } from "@/server/kernel/date-rules";
import { withWorkspace } from "@/server/kernel/tx";

let n = 0;
async function seedFresh() {
  const sub = `fw-replay-${Date.now().toString(36)}-${n++}`;
  const { workspaceId } = await seedWorkspace({ ...FERNWOOD, subdomain: sub }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES);
  await seedCapabilities(workspaceId);
  return workspaceId;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

// Everything the seed and its rules wrote, with every id written as what it names.
async function dump(workspaceId: string) {
  return withWorkspace({ workspaceId }, async (tx) => {
    const names = new Map<string, string>();
    for (const p of await tx.select().from(people)) names.set(p.id, p.email);
    for (const c of await tx.select().from(capabilities)) names.set(c.id, c.name);
    for (const u of await tx.select().from(uploads)) names.set(u.id, `file:${u.name}`);
    const allRows = await tx.select().from(rows).orderBy(asc(rows.seq));
    allRows.forEach((r, i) => names.set(r.id, `row:${names.get(r.capabilityId)}/${r.sheetId}/${i}`));
    const plain = (v: unknown) => JSON.parse(JSON.stringify(v).replace(UUID, (id) => names.get(id) ?? "?"));
    // Rows written in the same instant come back in any order: sort what has no order of its own.
    const sorted = <T,>(list: T[]) => plain(list).sort((x: unknown, y: unknown) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));

    return plain({
      rows: allRows.map(({ id, data, stepId, sheetId, capabilityId, createdBy, createdAt, updatedAt, deletedAt, fileVersion }) => ({ id, data, stepId, sheetId, capabilityId, createdBy, createdAt, updatedAt, deletedAt, fileVersion })),
      waits: sorted((await tx.select().from(waits)).map(({ id: _id, workspaceId: _w, ...w }) => w)),
      ruleRuns: sorted((await tx.select().from(ruleRuns)).map(({ id: _id, workspaceId: _w, ...r }) => r)),
      outbox: sorted((await tx.select().from(outbox)).map(({ id: _id, workspaceId: _w, sentAt: _s, ...o }) => o)),
      audit: (await tx.select().from(auditEntries).orderBy(asc(auditEntries.seq)))
        .filter((e) => !e.event.startsWith("workspace") && !e.event.startsWith("auth"))
        .map((e) => ({ at: e.at, who: e.who, capability: e.capabilityId, event: e.event, details: e.details })),
    });
  });
}

describe("the seeded rules replay the same every run", () => {
  it("two runs of the seed give the same rows, waits, runs, emails and Audit log", { timeout: 120_000 }, async () => {
    const [a, b] = [await seedFresh(), await seedFresh()];
    const [first, second] = [await dump(a), await dump(b)];
    // The workspace itself differs only by its address, which nothing the rules wrote mentions.
    expect(second).toEqual(first);
    expect(first.ruleRuns.length).toBeGreaterThan(0);
    expect(first.waits.length).toBeGreaterThan(0);
  });

  it("running the daily job again on Oct 27 changes nothing", { timeout: 60_000 }, async () => {
    const ws = await seedFresh();
    const before = await dump(ws);
    const again = await withWorkspace({ workspaceId: ws }, (tx) => runDateRules(tx, systemCtx(ws, new Date("2026-10-27T11:00:00Z"))));
    expect(again).toEqual({ ran: 0 });
    expect(await dump(ws)).toEqual(before);
  });
});
