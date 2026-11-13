import { beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { auditEntries, rows } from "@/db/schema";
import { kernelWorkspace } from "@/tests/kernel";
import { validateFile } from "./schema/validate";
import type { CapabilityFile } from "./schema/file";
import { createRow, deletePreview, deleteRows, getRow } from "./rows";

// G1: a pick from a list. Deleting a category empties the link on the rows that picked it, in its own app and in
// others, and those rows stay; rows that belong to it (its notes) still go with it.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let lists: string;
let requests: string;

const everyone = { id: "all", name: "Everyone", members: { kind: "everyone" as const }, can: ["see" as const, "add" as const, "edit" as const, "delete" as const], scope: "all" as const };

function listsFile(): CapabilityFile {
  return {
    name: "Lists",
    icon: "list",
    sheets: [
      {
        id: "categories",
        name: "Categories",
        kind: "list",
        row: { one: "category", many: "categories" },
        titleColumn: "name",
        columns: [
          { id: "name", name: "Name", type: "text", required: true },
          { id: "used", name: "Items", type: "computed", result: "number", expr: { sumOf: { sheet: "items", column: "qty", by: "category" } } },
        ],
      },
      {
        id: "items",
        name: "Items",
        kind: "list",
        row: { one: "item", many: "items" },
        titleColumn: "name",
        columns: [
          { id: "name", name: "Name", type: "text", required: true },
          { id: "qty", name: "Quantity", type: "number" },
          { id: "category", name: "Category", type: "link", link: { sheet: "categories", pick: true } },
        ],
      },
      {
        id: "notes",
        name: "Notes",
        kind: "list",
        row: { one: "note", many: "notes" },
        titleColumn: "text",
        columns: [
          { id: "text", name: "Note", type: "text", required: true },
          { id: "category", name: "Category", type: "link", link: { sheet: "categories" } },
        ],
      },
    ],
    roles: [everyone],
    rules: [],
    later: [],
  };
}

function requestsFile(listsId: string): CapabilityFile {
  return {
    name: "Requests",
    icon: "inbox",
    sheets: [
      {
        id: "requests",
        name: "Requests",
        kind: "list",
        row: { one: "request", many: "requests" },
        titleColumn: "what",
        columns: [
          { id: "what", name: "What", type: "text", required: true },
          { id: "category", name: "Category", type: "link", required: true, link: { capability: listsId, sheet: "categories", pick: true } },
        ],
      },
    ],
    roles: [everyone],
    rules: [],
    later: [],
  };
}

const add = (cap: string, sheet: string, values: Record<string, unknown>) => k.as("ada", (tx, c) => createRow(tx, c, cap, sheet, { values }));

beforeAll(async () => {
  k = await kernelWorkspace();
  lists = await k.create(listsFile());
  requests = await k.create(requestsFile(lists));
});

describe("a pick from a list", () => {
  it("is checked: never on a link to the row a row sits under", () => {
    const file = listsFile();
    const cats = file.sheets[0]!;
    cats.kind = "tree";
    cats.columns.push({ id: "under", name: "Under", type: "link", link: { sheet: "categories", pick: true } });
    cats.tree = { parent: "under" };
    const r = validateFile(file);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/isn't a pick from a list/);
  });

  it("deleting the row it points to empties it, here and in other apps; rows that belong to it go", async () => {
    const travel = await add(lists, "categories", { name: "Travel" });
    const taxi = await add(lists, "items", { name: "Taxi", qty: 2, category: travel.id });
    const note = await add(lists, "notes", { text: "Keep receipts", category: travel.id });
    const trip = await add(requests, "requests", { what: "Trip to Lyon", category: travel.id });
    expect((await k.as("ada", (tx, c) => getRow(tx, c, travel.id))).data.used).toBe(2);

    const preview = await k.as("ada", (tx, c) => deletePreview(tx, c, [travel.id]));
    expect(preview.alsoDeleted).toEqual([{ one: "note", many: "notes", count: 1 }]);
    expect(preview.alsoEmptied).toEqual([
      { one: "item", many: "items", column: "Category", count: 1 },
      { one: "request", many: "requests", column: "Category", count: 1 },
    ]);

    expect(await k.as("ada", (tx, c) => deleteRows(tx, c, [travel.id]))).toEqual({ deleted: 1, alsoDeleted: 1, alsoEmptied: 2 });
    await k.as("ada", async (tx, c) => {
      expect((await getRow(tx, c, taxi.id)).data.category).toBeUndefined();
      expect((await getRow(tx, c, trip.id)).data.category).toBeUndefined();
      await expect(getRow(tx, c, note.id)).rejects.toThrow("doesn't exist");
      const [entry] = await tx.select().from(auditEntries).orderBy(desc(auditEntries.seq)).limit(1);
      expect(entry).toMatchObject({ event: "row.deleted", details: { sheet: "Categories", rows: ["Travel"], alsoDeleted: 1, alsoEmptied: 2 } });
    });
  });

  it("a required pick is emptied too, and its row stays", async () => {
    const office = await add(lists, "categories", { name: "Office" });
    const desk = await add(requests, "requests", { what: "Desk", category: office.id });
    await k.as("ada", (tx, c) => deleteRows(tx, c, [office.id]));
    await k.as("ada", async (tx) => {
      const [r] = await tx.select().from(rows).where(eq(rows.id, desk.id));
      expect(r!.deletedAt).toBeNull();
    });
  });

  it("an entry of a ledger is kept as it is, so the row it picked can't be deleted", async () => {
    const stock = await k.create({
      name: "Stock",
      icon: "box",
      sheets: [
        {
          id: "items",
          name: "Items",
          kind: "list",
          row: { one: "item", many: "items" },
          titleColumn: "name",
          columns: [{ id: "name", name: "Name", type: "text", required: true }],
        },
        {
          id: "moves",
          name: "Moves",
          kind: "ledger",
          row: { one: "move", many: "moves" },
          ledger: { account: "item", amount: "qty", balance: "after", reverses: "reverses" },
          titleColumn: "what",
          columns: [
            { id: "what", name: "What", type: "text", required: true },
            { id: "item", name: "Item", type: "link", required: true, link: { sheet: "items", pick: true } },
            { id: "qty", name: "Quantity", type: "number", required: true },
            { id: "reverses", name: "Reverses", type: "link", link: { sheet: "moves" } },
            { id: "after", name: "Balance after", type: "number" },
          ],
        },
      ],
      roles: [{ ...everyone, sheets: ["items"] }, { ...everyone, id: "moves", name: "Everyone (moves)", can: ["see", "add"], sheets: ["moves"] }],
      rules: [],
      later: [],
    } satisfies CapabilityFile);
    const paper = await add(stock, "items", { name: "Paper" });
    await add(stock, "moves", { what: "Delivery", item: paper.id, qty: 10 });
    await expect(k.as("ada", (tx, c) => deleteRows(tx, c, [paper.id]))).rejects.toThrow("Paper has moves, which are only added, so it can't be deleted.");
  });

  it("deleting a row with nothing picking it is as before", async () => {
    const solo = await add(lists, "categories", { name: "Unused" });
    expect(await k.as("ada", (tx, c) => deleteRows(tx, c, [solo.id]))).toEqual({ deleted: 1, alsoDeleted: 0, alsoEmptied: 0 });
  });
});
