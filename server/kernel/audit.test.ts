import { beforeAll, describe, expect, it } from "vitest";
import { kernelWorkspace } from "@/tests/kernel";
import { contractsFile } from "./fixtures";
import { createRow, updateRow } from "./rows";
import { auditCsv, auditPeople, listAudit } from "./audit";

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let cap: string;

beforeAll(async () => {
  k = await kernelWorkspace();
  cap = await k.create(contractsFile([k.id.ada]));
  const { id } = await k.as("ada", (tx, c) => createRow(tx, c, cap, "contracts", { values: { customer: "Northwind", value: 3_840_000 } }));
  await k.as("ada", (tx, c) => updateRow(tx, c, id, { value: 4_100_000 }));
});

describe("Audit log", () => {
  it("lists entries newest first, as recorded, with the count of all", async () => {
    const { entries, matching, total } = await k.as("ada", (tx, c) => listAudit(tx, c));
    expect(entries[0]).toMatchObject({ who: k.email("ada"), capability: "Customer contracts", event: "row.updated" });
    expect(entries[0]!.details).toMatchObject({ changes: [{ name: "Value a year", from: 38_400, to: 41_000 }] });
    expect(matching).toBe(total);
    expect(entries.map((e) => e.event)).toContain("workspace.created");
  });

  it("searches, and filters by app and person", async () => {
    const found = await k.as("ada", (tx, c) => listAudit(tx, c, { search: "northwind" }));
    expect(found.entries.map((e) => e.event)).toEqual(["row.updated", "row.created"]);
    expect(found.matching).toBe(2);
    expect(found.total).toBeGreaterThan(2);
    const byCap = await k.as("ada", (tx, c) => listAudit(tx, c, { capabilityId: cap }));
    expect(byCap.entries.map((e) => e.event)).toEqual(["row.updated", "row.created", "capability.created"]);
    expect((await k.as("ada", (tx, c) => listAudit(tx, c, { who: k.email("maya") }))).entries).toEqual([]);
    expect(await k.as("ada", (tx, c) => auditPeople(tx, c))).toContain(k.email("ada"));
    expect((await k.as("ada", (tx, c) => listAudit(tx, c, { search: "100%" }))).entries).toEqual([]);
  });

  it("downloads the same rows as CSV", async () => {
    const csv = await k.as("ada", (tx, c) => auditCsv(tx, c, { capabilityId: cap }));
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toBe("Time (UTC),Who,App,Event,Details");
    expect(lines[1]).toMatch(new RegExp(`^\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d,${k.email("ada")},Customer contracts,row.updated,Contracts/Northwind · Value a year 38400 → 41000$`));
    expect(lines[3]).toMatch(/capability\.created,"v1 · 1 sheet, 5 steps, 0 rules, 2 roles"$/);
  });

  it("keeps the order things happened in, even within one millisecond, on one clock", async () => {
    // A capability and three writes to it, all at the same instant.
    const at = new Date("2026-10-27T16:00:00.000Z");
    const same = await k.create(contractsFile([k.id.ada]));
    await k.as(
      "ada",
      async (tx, c) => {
        const { id } = await createRow(tx, c, same, "contracts", { values: { customer: "Same moment", value: 100 } });
        await updateRow(tx, c, id, { value: 200 });
        await updateRow(tx, c, id, { value: 300 });
      },
      at,
    );
    const { entries } = await k.as("ada", (tx, c) => listAudit(tx, c, { capabilityId: same }));
    expect(entries.map((e) => e.event)).toEqual(["row.updated", "row.updated", "row.created", "capability.created"]);
    expect(entries.slice(0, 2).map((e) => (e.details as { changes: { to: number }[] }).changes[0]!.to)).toEqual([3, 2]);
    // Entries given no time take the app's clock, never the database's: the pinned day, before the writes above.
    expect(entries.at(-1)!.at.toISOString().slice(0, 10)).toBe("2026-10-27");
  });

  it("is for admins only, in the kernel", async () => {
    await expect(k.as("maya", (tx, c) => listAudit(tx, c))).rejects.toThrow(/Only admins/);
    await expect(k.as("maya", (tx, c) => auditCsv(tx, c))).rejects.toThrow(/Only admins/);
  });
});
