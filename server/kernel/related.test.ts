import { beforeAll, describe, expect, it } from "vitest";
import { kernelWorkspace } from "@/tests/kernel";
import { recordFile } from "@/tests/record";
import { relatedRows } from "./related";
import { createRow } from "./rows";

// What points at a row (0.4, M22): a contract's renewals and contacts, each sheet through its own access.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let cap: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  k = await kernelWorkspace();
  cap = await k.create(recordFile([k.id.ada]));
  const add = (sheet: string, values: Record<string, unknown>) => k.as("ada", (tx, c) => createRow(tx, c, cap, sheet, { values })).then((r) => r.id);
  ids.northwind = await add("contracts", { customer: "Northwind", value: 3_840_000, owner: k.id.rita });
  ids.brightline = await add("contracts", { customer: "Brightline", value: 5_760_000, owner: k.id.ada });
  await add("renewals", { contract: ids.northwind, due: "2026-11-14", new_value: 4_000_000 });
  await add("renewals", { contract: ids.brightline, due: "2027-02-02" });
  await add("contacts", { contract: ids.northwind, name: "Dana Whitfield", email: "dana@northwind.com" });
  await add("contacts", { contract: ids.northwind, name: "Accounts payable" });
});

describe("related rows", () => {
  it("a contract's renewals and contacts, with counts, titles and two answers each", async () => {
    const r = await k.as("ada", (tx, c) => relatedRows(tx, c, ids.northwind!));
    expect(r.map((s) => [s.sheet, s.count, s.canAdd, s.addAction])).toEqual([
      ["Renewals", 1, true, "Add renewal"],
      ["Contacts", 2, true, "Add contact"],
    ]);
    expect(r[0]!.rows[0]).toMatchObject({ title: "Northwind", data: { due: "2026-11-14", new_value: 4_000_000 } });
    expect(r[1]!.rows.map((x) => x.title).sort()).toEqual(["Accounts payable", "Dana Whitfield"]);
    expect(r[1]!.column).toEqual({ id: "contract", name: "Contract" });
  });

  it("an owner gets only what her access gives: renewals of her contract, no contacts, nothing to add", async () => {
    const r = await k.as("rita", (tx, c) => relatedRows(tx, c, ids.northwind!));
    expect(r.map((s) => [s.sheet, s.count, s.canAdd])).toEqual([["Renewals", 1, false]]);
    await expect(k.as("rita", (tx, c) => relatedRows(tx, c, ids.brightline!))).rejects.toThrow(/can't see it|doesn't exist/);
    await expect(k.as("maya", (tx, c) => relatedRows(tx, c, ids.northwind!))).rejects.toThrow(/can't see it|doesn't exist/);
  });

  it("a renewal can't be linked to a contract the person can't see", async () => {
    await expect(k.as("rita", (tx, c) => createRow(tx, c, cap, "renewals", { values: { contract: ids.brightline } }))).rejects.toThrow();
  });
});
