import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { waits } from "@/db/schema";
import { kernelWorkspace } from "@/tests/kernel";
import { checkImport, peopleKeys } from "./plans/import-check";
import { getRow, importRows, listRows, moveStep, updateRow } from "./rows";
import type { CapabilityFile } from "./schema/file";
import { waitingFor } from "./waiting";

// 4c's "Leave them for Lena to check": rows an import brings with required columns empty come in at the
// first step, wait on the person named until each is filled, and can't move on before.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let spend: string;

const spendFile = (): CapabilityFile => ({
  name: "Spend",
  icon: "wallet",
  sheets: [
    {
      id: "expenses",
      name: "Expenses",
      kind: "list",
      titleColumn: "what",
      columns: [
        { id: "what", name: "What for", type: "text", required: true },
        { id: "category", name: "Category", type: "choice", required: true, options: [{ id: "travel", name: "Travel" }, { id: "other", name: "Other" }] },
        { id: "amount", name: "Amount", type: "money", required: true },
        { id: "status", name: "Status", type: "step" },
      ],
      steps: [
        { id: "submitted", name: "Submitted", start: true },
        { id: "approved", name: "Approved" },
        { id: "paid", name: "Paid", end: "final" },
      ],
    },
  ],
  roles: [{ id: "admins", name: "Admins", members: { kind: "people", people: [k.id.ada, k.id.rita] }, can: ["see", "add", "edit", "move_steps"], scope: "all" }],
  rules: [],
  later: [],
});

const TABLE = [
  ["What", "Category", "Amount", "Status"],
  ["Taxi", "Travel", "40", "Paid"],
  ["Lunch", "", "25", "Paid"],
  ["Hotel", "", "abc", "Paid"], // unreadable amount: left out, not a gap
];
const MAPPING = [
  { from: "What", to: "What for", format: null, values: [] },
  { from: "Category", to: "Category", format: null, values: [] },
  { from: "Amount", to: "Amount", format: null, values: [] },
  { from: "Status", to: "Status", format: null, values: [] },
];

beforeAll(async () => {
  k = await kernelWorkspace();
  spend = await k.create(spendFile());
});

describe("rows with empty required columns from an import", () => {
  it("the import check keeps them apart, at the first step, from rows it can't read", () => {
    const out = checkImport(spendFile().sheets[0]!, TABLE, MAPPING, peopleKeys([]));
    expect(out.rows.map((r) => r.values.what)).toEqual(["Taxi"]);
    expect(out.gaps).toEqual([{ row: "Lunch", values: { what: "Lunch", amount: 2500, status: "submitted" }, missing: ["category"] }]);
  });

  it("come in waiting on the person named, fill one column at a time, and move on once filled", async () => {
    const out = checkImport(spendFile().sheets[0]!, TABLE, MAPPING, peopleKeys([]));
    const [, lunch] = await k.as("ada", (tx, c) =>
      importRows(tx, c, spend, "expenses", out.rows, { source: "zoho.csv", gaps: { rows: out.gaps, personId: k.id.rita, label: "Fill in the category" } }),
    );
    expect((await k.as("ada", (tx, c) => listRows(tx, c, spend, "expenses"))).length).toBe(2);
    const rita = await k.as("rita", (tx, c) => waitingFor(tx, c));
    expect(rita.map((w) => [w.title, w.label, w.step])).toEqual([["Lunch", "Fill in the category", "Submitted"]]);

    // Another edit works while the category is still empty; moving on doesn't.
    await k.as("rita", (tx, c) => updateRow(tx, c, lunch!, { amount: 2600 }));
    await expect(k.as("rita", (tx, c) => moveStep(tx, c, lunch!, "approved"))).rejects.toThrow("Lunch needs Category filled in before it moves on.");

    await k.as("rita", (tx, c) => updateRow(tx, c, lunch!, { category: "other" }));
    const open = await k.as("ada", (tx) => tx.select().from(waits).where(and(eq(waits.rowId, lunch!), isNull(waits.clearedAt))));
    expect(open).toEqual([]);
    await k.as("rita", (tx, c) => moveStep(tx, c, lunch!, "approved"));
    expect((await k.as("ada", (tx, c) => getRow(tx, c, lunch!))).data.status).toBe("approved");
  });

  it("an ordinary edit still can't leave a required column empty", async () => {
    const [taxi] = await k.as("ada", (tx, c) => listRows(tx, c, spend, "expenses", { filters: [] })).then((r) => r.filter((x) => x.data.what === "Taxi").map((x) => x.id));
    await expect(k.as("ada", (tx, c) => updateRow(tx, c, taxi!, { category: null }))).rejects.toThrow("Category is required.");
  });

  it("refuses someone who isn't in People", async () => {
    const out = checkImport(spendFile().sheets[0]!, TABLE, MAPPING, peopleKeys([]));
    await expect(
      k.as("ada", (tx, c) => importRows(tx, c, spend, "expenses", [], { source: "zoho.csv", gaps: { rows: out.gaps, personId: crypto.randomUUID(), label: "Fill in" } })),
    ).rejects.toThrow("isn't in People");
  });
});

describe("a link column and a file", () => {
  it("can't be filled from a file's text: the mapping is sent back, and rows miss it as a gap", () => {
    const sheet = { ...spendFile().sheets[0]!, columns: [...spendFile().sheets[0]!.columns, { id: "trip", name: "Trip", type: "link" as const, required: true, link: { sheet: "trips" } }] };
    const table = [["What", "Category", "Amount", "Trip"], ["Taxi", "Travel", "40", "Berlin offsite"]];
    const out = checkImport(sheet, table, [...MAPPING.slice(0, 3), { from: "Trip", to: "Trip", format: null, values: [] }], peopleKeys([]));
    expect(out.problems).toEqual(["Trip links to another sheet, so a file can't fill it; leave it unmapped."]);
    expect(out.gaps.map((g) => g.missing)).toEqual([["trip"]]);
  });

  it("nor can a file column: a Yes / No receipt column isn't a receipt", () => {
    const sheet = { ...spendFile().sheets[0]!, columns: [...spendFile().sheets[0]!.columns, { id: "receipt", name: "Receipt", type: "file" as const }] };
    const table = [["What", "Category", "Amount", "Receipt"], ["Taxi", "Travel", "40", "Yes"]];
    const out = checkImport(sheet, table, [...MAPPING.slice(0, 3), { from: "Receipt", to: "Receipt", format: null, values: [] }], peopleKeys([]));
    expect(out.problems).toEqual(["Receipt holds an uploaded file, so a file's text can't fill it; leave it unmapped."]);
    expect(out.rows).toHaveLength(1);
  });
});

describe("a build's history", () => {
  it("comes in without starting rules; an ordinary import still starts them", async () => {
    const file = spendFile();
    const withRule: CapabilityFile = {
      ...file,
      name: "Spend with approvals",
      rules: [{ id: "approve", text: "Rita approves each new expense.", reading: { when: "w", then: "t" }, trigger: { kind: "row_created", sheet: "expenses" }, actions: [{ kind: "ask_person", person: k.id.rita, step: "submitted", label: "Approve" }], enabled: true }],
    };
    const cap = await k.create(withRule);
    const rows = [{ values: { what: "Taxi", category: "travel", amount: 4000, status: "submitted" } }];
    await k.as("ada", (tx, c) => importRows(tx, c, cap, "expenses", rows, { source: "zoho.csv", history: true }));
    expect((await k.as("rita", (tx, c) => waitingFor(tx, c, { capabilityId: cap }))).length).toBe(0);
    await k.as("ada", (tx, c) => importRows(tx, c, cap, "expenses", rows, { source: "contracts.csv" }));
    expect((await k.as("rita", (tx, c) => waitingFor(tx, c, { capabilityId: cap }))).length).toBe(1);
  });
});
