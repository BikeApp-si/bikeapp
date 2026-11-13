import { beforeAll, describe, expect, it } from "vitest";
import { kernelWorkspace } from "@/tests/kernel";
import { recordFile } from "@/tests/record";
import { accessSummary, summaryHash } from "./access-summary";
import { createRow } from "./rows";

// What one person can do in one capability (0.4, M24): only what their access gives, and the same summary (and hash)
// for everyone with the same access.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let cap: string;

beforeAll(async () => {
  k = await kernelWorkspace();
  cap = await k.create(recordFile([k.id.ada]));
  await k.as("ada", (tx, c) => createRow(tx, c, cap, "contracts", { values: { customer: "Northwind", value: 3_840_000, owner: k.id.rita } }));
  await k.as("ada", (tx, c) => createRow(tx, c, cap, "contracts", { values: { customer: "Kova", value: 1_080_000, owner: k.id.omar } }));
});

describe("access summary", () => {
  it("an admin who manages it: every sheet, all rows, add, edit, delete, every move", async () => {
    const s = await k.as("ada", (tx, c) => accessSummary(tx, c, cap));
    expect(s).toMatchObject({ capability: "Customer contracts", admin: true });
    expect(s.sheets.map((x) => [x.name, x.sees, !!x.add, x.edit, x.delete])).toEqual([
      ["Contracts", "all", true, true, true],
      ["Renewals", "all", true, true, true],
      ["Contacts", "all", true, true, true],
    ]);
    expect(s.sheets[0]!.movesTo).toEqual(["Draft", "Signed", "Legal review", "Active", "Ended", "Renewed"]);
  });

  it("an owner: her own contracts and their renewals, no contacts, nothing to add", async () => {
    const s = await k.as("rita", (tx, c) => accessSummary(tx, c, cap));
    expect(s.admin).toBe(false);
    expect(s.sheets.map((x) => [x.name, x.sees, x.add, x.edit, x.delete])).toEqual([
      ["Contracts", "own", null, true, false],
      ["Renewals", "own", null, true, false],
    ]);
  });

  it("names no one, so two owners share it; someone with no access is refused", async () => {
    const rita = await k.as("rita", (tx, c) => accessSummary(tx, c, cap));
    const omar = await k.as("omar", (tx, c) => accessSummary(tx, c, cap));
    expect(summaryHash(omar)).toBe(summaryHash(rita));
    await expect(k.as("maya", (tx, c) => accessSummary(tx, c, cap))).rejects.toThrow(/can't see it/);
  });
});
