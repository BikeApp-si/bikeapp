import { beforeAll, describe, expect, it } from "vitest";
import { kernelWorkspace } from "@/tests/kernel";
import type { CapabilityFile } from "./schema/file";
import { createRow, listRows, moveStep, movesForAll, sheetTotals } from "./rows";

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let cap: string;

// Contracts with owners: managers see all; owners see their own.
function file(manager: string): CapabilityFile {
  return {
    name: "Contracts",
    icon: "file-pen-line",
    sheets: [
      {
        id: "contracts",
        name: "Contracts",
        kind: "list",
        titleColumn: "customer",
        sort: { column: "renews", dir: "asc" },
        columns: [
          { id: "customer", name: "Customer", type: "text", required: true },
          { id: "value", name: "Value a year", type: "money" },
          { id: "renews", name: "Renews on", type: "date" },
          { id: "owner", name: "Owner", type: "person" },
          { id: "left", name: "Days left", type: "computed", result: "days", expr: { op: "days_until", args: [{ col: "renews" }] } },
          { id: "status", name: "Status", type: "step" },
        ],
        steps: [
          { id: "draft", name: "Draft", start: true },
          { id: "active", name: "Active" },
          { id: "ended", name: "Ended", end: "exit" },
        ],
      },
    ],
    roles: [
      { id: "managers", name: "Managers", members: { kind: "people", people: [manager] }, can: ["see", "add", "edit", "move_steps"], scope: "all" },
      { id: "owners", name: "Owners", members: { kind: "column", sheet: "contracts", column: "owner" }, can: ["see"], scope: "own", scopeColumns: { contracts: { column: "owner" } } },
    ],
    rules: [],
    later: [],
  };
}

const names = (rs: { data: Record<string, unknown> }[]) => rs.map((r) => r.data.customer);

beforeAll(async () => {
  k = await kernelWorkspace();
  cap = await k.create(file(k.id.ada));
  const add = (customer: string, value: number, renews: string | null, owner: "rita" | "priya") =>
    k.as("ada", (tx, c) => createRow(tx, c, cap, "contracts", { values: { customer, value, renews, owner: k.id[owner] } }));
  await add("Northwind", 3_840_000, "2026-11-14", "priya");
  await add("Kova", 1_080_000, "2027-03-09", "rita");
  await add("Quill Media", 1_200_000, null, "rita");
  await add("Acme Health", 2_880_000, "2026-11-28", "priya");
  await add("Orbit Health", 1_440_000, "2027-01-09", "rita");
});

describe("filters and sort", () => {
  it("sorts by the sheet's own order, empty values last", async () => {
    const rs = await k.as("ada", (tx, c) => listRows(tx, c, cap, "contracts"));
    expect(names(rs)).toEqual(["Northwind", "Acme Health", "Orbit Health", "Kova", "Quill Media"]);
  });

  it("sorts by money and by person name either way", async () => {
    const byValue = await k.as("ada", (tx, c) => listRows(tx, c, cap, "contracts", { sort: { column: "value", dir: "desc" } }));
    expect(names(byValue)).toEqual(["Northwind", "Acme Health", "Orbit Health", "Quill Media", "Kova"]);
    const byOwner = await k.as("ada", (tx, c) => listRows(tx, c, cap, "contracts", { sort: { column: "owner", dir: "asc" } }));
    expect(byOwner.slice(0, 2).map((r) => r.data.owner)).toEqual([k.id.priya, k.id.priya]);
  });

  it("combines filters with and", async () => {
    const rs = await k.as("ada", (tx, c) =>
      listRows(tx, c, cap, "contracts", {
        filters: [
          { column: "customer", op: "contains", text: "health" },
          { column: "value", op: "between", from: 2_000_000 },
        ],
      }),
    );
    expect(names(rs)).toEqual(["Acme Health"]);
    const inDates = await k.as("ada", (tx, c) => listRows(tx, c, cap, "contracts", { filters: [{ column: "renews", op: "between", from: "2026-12-01", to: "2027-12-31" }] }));
    expect(names(inDates)).toEqual(["Orbit Health", "Kova"]);
  });

  it("treats % and _ in a search as plain text", async () => {
    const rs = await k.as("ada", (tx, c) => listRows(tx, c, cap, "contracts", { filters: [{ column: "customer", op: "contains", text: "%" }] }));
    expect(rs).toEqual([]);
  });

  it("never reaches past access: Rita's filter on Priya's rows finds nothing", async () => {
    const rs = await k.as("rita", (tx, c) => listRows(tx, c, cap, "contracts", { filters: [{ column: "owner", op: "in", values: [k.id.priya] }] }));
    expect(rs).toEqual([]);
    const all = await k.as("rita", (tx, c) => listRows(tx, c, cap, "contracts"));
    expect(names(all)).toEqual(["Orbit Health", "Kova", "Quill Media"]);
  });

  it("loads a part at a time, in the same order", async () => {
    const first = await k.as("ada", (tx, c) => listRows(tx, c, cap, "contracts", { limit: 2 }));
    const rest = await k.as("ada", (tx, c) => listRows(tx, c, cap, "contracts", { limit: 2, offset: 2 }));
    expect([...names(first), ...names(rest)]).toEqual(["Northwind", "Acme Health", "Orbit Health", "Kova"]);
  });

  it("counts and adds up every matching row the person can see", async () => {
    expect(await k.as("ada", (tx, c) => sheetTotals(tx, c, cap, "contracts"))).toEqual({ count: 5, sums: { value: 10_440_000 } });
    expect(await k.as("rita", (tx, c) => sheetTotals(tx, c, cap, "contracts"))).toEqual({ count: 3, sums: { value: 3_720_000 } });
    const filtered = await k.as("ada", (tx, c) => sheetTotals(tx, c, cap, "contracts", { filters: [{ column: "status", op: "in", values: ["draft"] }] }));
    expect(filtered.count).toBe(5);
  });

  it("finds the steps several rows can all move to", async () => {
    const rs = await k.as("ada", (tx, c) => listRows(tx, c, cap, "contracts", { limit: 2 }));
    expect(await k.as("ada", (tx, c) => movesForAll(tx, c, rs.map((r) => r.id)))).toEqual([
      { id: "active", name: "Active" },
      { id: "ended", name: "Ended" },
    ]);
    await k.as("ada", (tx, c) => moveStep(tx, c, rs[0]!.id, "active"));
    expect((await k.as("ada", (tx, c) => movesForAll(tx, c, rs.map((r) => r.id)))).map((m) => m.id)).toEqual(["ended"]);
  });

  it("refuses a column that changes every day, or a filter that doesn't fit the column", async () => {
    await expect(k.as("ada", (tx, c) => listRows(tx, c, cap, "contracts", { sort: { column: "left", dir: "asc" } }))).rejects.toThrow(/changes every day/);
    await expect(k.as("ada", (tx, c) => listRows(tx, c, cap, "contracts", { filters: [{ column: "value", op: "contains", text: "1" }] }))).rejects.toThrow(/isn't text/);
    await expect(k.as("ada", (tx, c) => listRows(tx, c, cap, "contracts", { filters: [{ column: "nope", op: "in", values: [] }] }))).rejects.toThrow(/no such column/);
  });
});
