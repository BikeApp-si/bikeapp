import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { rows } from "@/db/schema";
import { kernelWorkspace } from "@/tests/kernel";
import { ordersFile, receiptsFile } from "./fixtures";
import { createRow, deleteRows, getRow, listRows, saveDocument, updateRow } from "./rows";

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let receipts: string;
let orders: string;

beforeAll(async () => {
  k = await kernelWorkspace();
  receipts = await k.create(receiptsFile([k.id.ada]));
  orders = await k.create(ordersFile(receipts, [k.id.ada]));
});

const order = (ref: string, lines: { item: string; qty: number; price: number }[], id?: string, lineIds: (string | undefined)[] = []) =>
  k.as("ada", (tx, c) => saveDocument(tx, c, orders, "orders", { id, values: { ref } }, lines.map((l, i) => ({ id: lineIds[i], values: l }))));
const read = (id: string) => k.as("ada", (tx, c) => getRow(tx, c, id)).then((r) => r.data);
const linesOf = (id: string) => k.as("ada", (tx, c) => listRows(tx, c, orders, "lines", { parentRowId: id }));

describe("document + lines", () => {
  it("is saved as one unit, with totals at both levels", async () => {
    const o = await order("PO-1", [
      { item: "Laptop", qty: 2, price: 150_000 },
      { item: "Dock", qty: 1, price: 25_000 },
    ]);
    const lines = await linesOf(o.id);
    expect(lines.map((l) => l.data.amount)).toEqual([300_000, 25_000]);
    expect(o.data).toMatchObject({ ref: "PO-1", total: 325_000, open: 325_000 });
  });

  it("recomputes the document when a line is added, changed or removed", async () => {
    const o = await order("PO-2", [{ item: "Monitor", qty: 1, price: 40_000 }]);
    const [line] = await linesOf(o.id);
    await k.as("ada", (tx, c) => updateRow(tx, c, line!.id, { qty: 3 }));
    expect((await read(o.id)).total).toBe(120_000);
    const extra = await k.as("ada", (tx, c) => createRow(tx, c, orders, "lines", { values: { item: "Cable", qty: 2, price: 1_000 }, parentRowId: o.id }));
    expect((await read(o.id)).total).toBe(122_000);
    await k.as("ada", (tx, c) => deleteRows(tx, c, [extra.id]));
    expect((await read(o.id)).total).toBe(120_000);
    // Saving the document without a line removes it.
    await order("PO-2", [], o.id);
    expect((await read(o.id)).total).toBe(0);
    expect(await linesOf(o.id)).toEqual([]);
  });

  it("saves nothing when one line is wrong", async () => {
    const before = await k.as("ada", (tx) => tx.$count(rows));
    await expect(order("PO-3", [{ item: "Desk", qty: 1, price: 30_000 }, { item: "Chair", qty: 0, price: 10_000 }])).rejects.toThrow("Quantity must be at least 1.");
    expect(await k.as("ada", (tx) => tx.$count(rows))).toBe(before);

    const o = await order("PO-4", [{ item: "Desk", qty: 1, price: 30_000 }]);
    const [line] = await linesOf(o.id);
    await expect(order("PO-4 changed", [{ item: "Desk", qty: 2, price: 30_000 }, { item: "Bad", qty: -1, price: 1 }], o.id, [line!.id])).rejects.toThrow();
    expect(await read(o.id)).toMatchObject({ ref: "PO-4", total: 30_000 });
  });

  it("a line belongs to one document and can't move to another", async () => {
    const a = await order("PO-5", [{ item: "Phone", qty: 1, price: 80_000 }]);
    const b = await order("PO-6", [{ item: "Case", qty: 1, price: 2_000 }]);
    const [line] = await linesOf(a.id);
    await expect(order("PO-6", [{ item: "Phone", qty: 1, price: 80_000 }], b.id, [line!.id])).rejects.toThrow("A line can't move to another document.");
    await expect(k.as("ada", (tx, c) => createRow(tx, c, orders, "lines", { values: { item: "Orphan", qty: 1, price: 1 } }))).rejects.toThrow("A line must belong to a document.");
    expect((await read(a.id)).total).toBe(80_000);
  });

  it("lines go with their document when it is deleted", async () => {
    const o = await order("PO-7", [{ item: "Mouse", qty: 1, price: 3_000 }]);
    const [line] = await linesOf(o.id);
    expect(await k.as("ada", (tx, c) => deleteRows(tx, c, [o.id]))).toEqual({ deleted: 1, alsoDeleted: 1, alsoEmptied: 0 });
    const [stored] = await k.as("ada", (tx) => tx.select().from(rows).where(and(eq(rows.id, line!.id), isNull(rows.deletedAt))));
    expect(stored).toBeUndefined();
  });
});

describe("allocation", () => {
  const receipt = (payer: string, received: number) =>
    k.as("ada", (tx, c) => createRow(tx, c, receipts, "receipts", { values: { payer, received } })).then((r) => r.id);
  const pay = (from: string, to: string, amount: number) =>
    k.as("ada", (tx, c) => createRow(tx, c, orders, "payments", { values: { receipt: from, order: to, amount } })).then((r) => r.id);

  it("keeps the open amount right as allocations are added, changed and removed", async () => {
    const o = await order("INV-1", [{ item: "Licence", qty: 1, price: 80_000 }]);
    const r = await receipt("Northwind", 100_000);
    const p = await pay(r, o.id, 60_000);
    expect(await read(o.id)).toMatchObject({ total: 80_000, paid: 60_000, open: 20_000 });
    await k.as("ada", (tx, c) => updateRow(tx, c, p, { amount: 50_000 }));
    expect(await read(o.id)).toMatchObject({ paid: 50_000, open: 30_000 });
    await k.as("ada", (tx, c) => deleteRows(tx, c, [p]));
    expect(await read(o.id)).toMatchObject({ total: 80_000, open: 80_000 });
  });

  it("never allocates more than the source, or more than the target's total", async () => {
    const big = await order("INV-2", [{ item: "Servers", qty: 1, price: 1_000_000 }]);
    const r = await receipt("Acme Health", 50_000);
    await pay(r, big.id, 30_000);
    await expect(pay(r, big.id, 30_000)).rejects.toThrow("That allocates $600 against this receipt, more than its $500.");

    const small = await order("INV-3", [{ item: "Seat", qty: 1, price: 10_000 }]);
    const r2 = await receipt("Kova", 100_000);
    await expect(pay(r2, small.id, 15_000)).rejects.toThrow("That allocates $150 against this order, more than its $100.");
    await expect(pay(r2, small.id, -1)).rejects.toThrow("Amount can't be below zero.");
  });

  it("refuses a change on either side that would leave more allocated than there is", async () => {
    const o = await order("INV-4", [{ item: "Training", qty: 2, price: 20_000 }]);
    const [line] = await linesOf(o.id);
    const r = await receipt("Orbit Health", 50_000);
    await pay(r, o.id, 40_000);
    await expect(k.as("ada", (tx, c) => updateRow(tx, c, r, { received: 30_000 }))).rejects.toThrow("$400 is already allocated against Received, more than its $300.");
    await expect(k.as("ada", (tx, c) => updateRow(tx, c, line!.id, { qty: 1 }))).rejects.toThrow("is already allocated against Total");
    expect(await read(o.id)).toMatchObject({ total: 40_000, open: 0 });
  });

  it("two allocations made at the same moment can't go over the source together", async () => {
    const r = await receipt("Lumen Retail", 50_000);
    const a = await order("INV-5", [{ item: "A", qty: 1, price: 100_000 }]);
    const b = await order("INV-6", [{ item: "B", qty: 1, price: 100_000 }]);
    const results = await Promise.allSettled([pay(r, a.id, 30_000), pay(r, b.id, 30_000)]);
    expect(results.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
    const paid = (await read(a.id)).paid ?? 0;
    const paidB = (await read(b.id)).paid ?? 0;
    expect(Number(paid) + Number(paidB)).toBe(30_000);
  });
});
