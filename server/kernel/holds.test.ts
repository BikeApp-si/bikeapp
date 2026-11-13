import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { capabilities, people, rows } from "@/db/schema";
import { withWorkspace } from "./tx";
import { holds } from "./holds";

// Finding rows by an id in their data through the index (M12) gives exactly the rows the old text comparison did:
// every person and every row id, in every person and link column of the seed.
const { seedFernwoodCopy } = await import("@/seed");
let ws: string;
beforeAll(async () => {
  ws = (await seedFernwoodCopy(`hd${Date.now().toString(36)}`)).workspaceId;
}, 120_000);

describe("rows holding an id", () => {
  it("are the same rows as data->>column = id", async () => {
    await withWorkspace({ workspaceId: ws }, async (tx) => {
      const all = await tx.select({ id: rows.id, cap: rows.capabilityId, sheet: rows.sheetId, data: rows.data }).from(rows);
      const ids = new Set([...all.map((r) => r.id), ...(await tx.select({ id: people.id }).from(people)).map((p) => p.id)]);
      // Every (capability, sheet, column, id) the seed's data holds.
      const pairs = new Map<string, { cap: string; sheet: string; column: string; id: string }>();
      for (const r of all)
        for (const [column, v] of Object.entries(r.data as Record<string, unknown>))
          if (typeof v === "string" && ids.has(v)) pairs.set(`${r.cap}|${r.sheet}|${column}|${v}`, { cap: r.cap, sheet: r.sheet, column, id: v });
      expect(pairs.size).toBeGreaterThan(50);
      for (const p of pairs.values()) {
        const where = and(eq(rows.capabilityId, p.cap), eq(rows.sheetId, p.sheet));
        const viaText = await tx.select({ id: rows.id }).from(rows).where(and(where, sql`${rows.data}->>${p.column} = ${p.id}`)).orderBy(rows.id);
        const viaIndex = await tx.select({ id: rows.id }).from(rows).where(and(where, holds(p.column, p.id))).orderBy(rows.id);
        expect(viaIndex, `${p.column} = ${p.id}`).toEqual(viaText);
      }
      expect(await tx.$count(capabilities)).toBeGreaterThan(0);
    });
  });
});
