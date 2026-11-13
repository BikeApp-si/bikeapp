import { beforeAll, describe, expect, it } from "vitest";
import { kernelWorkspace } from "@/tests/kernel";
import { filterWordsInput, filtersFrom, type WordFilter } from "./filter-words";
import { contractsFile } from "./fixtures";
import { createRow, listRows } from "./rows";

// Filters in plain words (0.4, M21), the kernel's half: the prompt reads only what the Filter menu offers, and the
// answer's names become the sheet's filters, each checked; what can't be used is said in plain words.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let contracts: string;
const now = new Date("2026-10-27T12:00:00Z");

beforeAll(async () => {
  k = await kernelWorkspace();
  contracts = await k.create(contractsFile([k.id.ada]));
  const add = (customer: string, value: number, start: string, owner: string) =>
    k.as("ada", (tx, c) => createRow(tx, c, contracts, "contracts", { values: { customer, value, start, owner } }));
  await add("Northwind", 3_840_000, "2025-11-15", k.id.rita);
  await add("Kova", 1_080_000, "2025-11-20", k.id.rita);
  await add("Brightline", 5_760_000, "2026-02-03", k.id.ada);
});

const f = (column: string, op: WordFilter["op"], rest: Partial<WordFilter>): WordFilter => ({ column, op, values: null, text: null, from: null, to: null, ...rest });

describe("what the prompt reads", () => {
  it("today, the columns the Filter menu offers with their steps, and people; nothing worked out each day", async () => {
    const { input } = await k.as("ada", (tx, c) => filterWordsInput(tx, c, contracts, "contracts", "renewing next month"), now);
    expect(input.today).toBe("2026-10-27");
    expect(input.columns.map((c) => c.name)).toEqual(["Customer", "Value a year", "Start", "Renews on", "Notice", "Owner", "Status"]);
    expect(input.columns.find((c) => c.name === "Status")!.options).toContain("Legal review");
    expect(input.people.map((p) => p.name)).toContain("Rita Gomez");
  });
  it("is refused for a sheet the person can't see, and for an empty request", async () => {
    await expect(k.as("maya", (tx, c) => filterWordsInput(tx, c, contracts, "contracts", "anything"))).rejects.toThrow(/can't see it/);
    await expect(k.as("ada", (tx, c) => filterWordsInput(tx, c, contracts, "contracts", "  "))).rejects.toThrow(/Describe the rows/);
  });
});

describe("the answer as filters", () => {
  let sheet: Awaited<ReturnType<typeof filterWordsInput>>["sheet"];
  let people: { id: string; name: string }[];
  beforeAll(async () => {
    ({ sheet, people } = await k.as("ada", (tx, c) => filterWordsInput(tx, c, contracts, "contracts", "x")));
  });

  it("turns names into ids and dollars into cents, and the rows match", async () => {
    const out = filtersFrom(sheet, people, {
      filters: [f("Renews on", "between", { from: "2026-11-01", to: "2026-11-30" }), f("value a year", "between", { from: "20000" }), f("Owner", "in", { values: ["Rita Gomez"] })],
      could_not: [],
    });
    expect(out.couldNot).toEqual([]);
    expect(out.filters).toEqual([
      { column: "renews", op: "between", from: "2026-11-01", to: "2026-11-30" },
      { column: "value", op: "between", from: 2_000_000, to: null },
      { column: "owner", op: "in", values: [k.id.rita] },
    ]);
    const rows = await k.as("ada", (tx, c) => listRows(tx, c, contracts, "contracts", { filters: out.filters }));
    expect(rows.map((r) => r.data.customer)).toEqual(["Northwind"]);
  });

  it("says plainly what it can't use: an unknown column or name, a bad date, a column worked out each day", () => {
    const out = filtersFrom(sheet, people, {
      filters: [f("Colour", "in", { values: ["red"] }), f("Status", "in", { values: ["Lost"] }), f("Start", "between", { from: "2026-02-30" }), f("Days left", "between", { to: "30" })],
      could_not: ["Bike can't filter by whether a receipt is attached."],
    });
    expect(out.filters).toEqual([]);
    expect(out.couldNot).toEqual([
      "Bike can't filter by whether a receipt is attached.",
      "Contracts has no column “Colour” to filter by.",
      "Status has no “Lost”.",
      "Start needs a real date.",
      "Contracts has no column “Days left” to filter by.",
    ]);
  });

  it("refuses a range the wrong way round and an op that doesn't fit the column", () => {
    const out = filtersFrom(sheet, people, { filters: [f("Value a year", "between", { from: "50000", to: "10000" }), f("Customer", "in", { values: ["Kova"] })], could_not: [] });
    expect(out.filters).toEqual([]);
    expect(out.couldNot).toEqual(["Value a year's from comes after its to.", "Customer is text, so it needs the words to look for."]);
  });
});
