import { beforeAll, describe, expect, it } from "vitest";
import { kernelWorkspace } from "@/tests/kernel";
import { contractsFile } from "./fixtures";
import { boardRows, createRow, groupTotals, listRows, moveStep, sheetTotals } from "./rows";
import { saveView } from "./saved-views";

// Groups and the board (0.4, M20): groups in their own order with counts and money subtotals that add up to the totals,
// rows in group order, a board by step, all inside the person's access.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let contracts: string;

beforeAll(async () => {
  k = await kernelWorkspace();
  contracts = await k.create(contractsFile([k.id.ada]));
  const add = (customer: string, value: number, owner: string, start: string | null) =>
    k.as("ada", (tx, c) => createRow(tx, c, contracts, "contracts", { values: { customer, value, owner, ...(start ? { start } : {}) } }));
  const a = await add("Northwind", 3_840_000, k.id.rita, "2025-11-15");
  await add("Kova", 1_080_000, k.id.rita, "2026-03-10");
  await add("Brightline", 5_760_000, k.id.ada, "2025-11-02");
  await add("Quill", 1_200_000, k.id.ada, null);
  await k.as("ada", (tx, c) => moveStep(tx, c, a.id, "signed"));
});

const groups = (who: "ada" | "rita", by: { column: string; by?: "team" | "month" }) => k.as(who, (tx, c) => groupTotals(tx, c, contracts, "contracts", { by }));

describe("groupTotals", () => {
  it("by step, in the steps' order, with counts and subtotals that add up to the totals", async () => {
    const g = await groups("ada", { column: "status" });
    expect(g.map((x) => [x.label, x.count])).toEqual([
      ["Draft", 3],
      ["Signed", 1],
    ]);
    const totals = await k.as("ada", (tx, c) => sheetTotals(tx, c, contracts, "contracts"));
    expect(g.reduce((n, x) => n + x.count, 0)).toBe(totals.count);
    expect(g.reduce((n, x) => n + x.sums.value!, 0)).toBe(totals.sums.value);
  });
  it("by person, by name; by month, in time, with the empty ones last", async () => {
    expect((await groups("ada", { column: "owner" })).map((x) => [x.label, x.count])).toEqual([
      ["Ada Admin", 2],
      ["Rita Gomez", 2],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    expect((await groups("ada", { column: "start", by: "month" })).map((x) => [x.label, x.count])).toEqual([
      ["Nov 2025", 2],
      ["Mar 2026", 1],
      ["No start", 1],
    ]);
    expect((await groups("ada", { column: "owner", by: "team" })).every((x) => x.count > 0)).toBe(true);
  });
  it("count only the rows the person can see", async () => {
    expect((await groups("rita", { column: "status" })).map((x) => [x.label, x.count])).toEqual([
      ["Draft", 1],
      ["Signed", 1],
    ]);
  });
  it("refuse a column rows can't be grouped by", async () => {
    await expect(groups("ada", { column: "customer" })).rejects.toThrow(/can't be grouped/);
  });
});

describe("rows in group order", () => {
  it("come group by group", async () => {
    const list = await k.as("ada", (tx, c) => listRows(tx, c, contracts, "contracts", { groupBy: { column: "status" } }));
    expect(list.map((r) => r.data.status)).toEqual(["draft", "draft", "draft", "signed"]);
  });
});

describe("the board", () => {
  it("has a column per step with its count and rows, only the person's", async () => {
    const board = await k.as("rita", (tx, c) => boardRows(tx, c, contracts, "contracts"));
    expect(board.map((b) => [b.step, b.count, b.rows.length])).toEqual([
      ["draft", 1, 1],
      ["signed", 1, 1],
      ["legal", 0, 0],
      ["active", 0, 0],
      ["ended", 0, 0],
      ["renewed", 0, 0],
    ]);
  });
  it("a view remembers the board and the grouping, checked against the sheet", async () => {
    const v = await k.as("ada", (tx, c) => saveView(tx, c, contracts, "contracts", { name: "Board", filters: [], sort: null, columns: null, shared: false, layout: "board", groupBy: { column: "owner" } }));
    expect(v).toMatchObject({ layout: "board", groupBy: { column: "owner" } });
    await expect(k.as("ada", (tx, c) => saveView(tx, c, contracts, "contracts", { name: "Bad", filters: [], sort: null, columns: null, shared: false, groupBy: { column: "customer" } }))).rejects.toThrow(/can't be grouped/);
  });
});
