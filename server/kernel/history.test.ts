import { beforeAll, describe, expect, it } from "vitest";
import { kernelWorkspace } from "@/tests/kernel";
import { recordFile } from "@/tests/record";
import { rowHistory } from "./history";
import { addNote } from "./notes";
import { bulkUpdate, createRow, moveStep, updateRow } from "./rows";

// A row's own History (0.4, M22): its changes and notes, newest first, only for people who may see the row; a rule's
// sentence for admins, only its moves of this row for others.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let northwind: string;
let cap: string;
const at = (min: number) => new Date(Date.UTC(2026, 9, 27, 15, min));

beforeAll(async () => {
  k = await kernelWorkspace();
  cap = await k.create(recordFile([k.id.ada]));
  northwind = (await k.as("ada", (tx, c) => createRow(tx, c, cap, "contracts", { values: { customer: "Northwind", value: 3_600_000, owner: k.id.rita } }), at(1))).id;
  await k.as("ada", (tx, c) => updateRow(tx, c, northwind, { value: 3_840_000 }), at(2));
  // Signed: the rule moves it on to Active.
  await k.as("rita", (tx, c) => moveStep(tx, c, northwind, "signed"), at(3));
  await k.as("rita", (tx, c) => addNote(tx, c, northwind, "Called Dana, they want the same price."), at(4));
});

describe("a row's History", () => {
  it("for an admin: the note, the rule, the move, the change and the creation, newest first", async () => {
    const h = await k.as("ada", (tx, c) => rowHistory(tx, c, northwind));
    expect(h.map((i) => [i.kind, i.who, i.text])).toEqual([
      ["note", "Rita Gomez", "Called Dana, they want the same price."],
      ["change", "A rule", "“When a contract is signed, move it on to Active.”: moved Signed → Active"],
      ["change", "Rita Gomez", "Moved from Draft to Signed"],
      ["change", "Ada Admin", "Value a year $36,000 → $38,400"],
      ["change", "Ada Admin", "Created"],
    ]);
    expect(h[0]!.when).toMatch(/^Oct 27, \d{1,2}:04 [AP]M$/);
  });

  it("for the owner: the rule's move of this row, not its sentence", async () => {
    const h = await k.as("rita", (tx, c) => rowHistory(tx, c, northwind));
    expect(h[1]).toMatchObject({ who: "A rule", text: "Moved from Signed to Active" });
  });

  it("a bulk change is on each row it changed", async () => {
    const kova = (await k.as("ada", (tx, c) => createRow(tx, c, cap, "contracts", { values: { customer: "Kova", value: 1_080_000 } }))).id;
    await k.as("ada", (tx, c) => bulkUpdate(tx, c, [northwind, kova], { values: { notice: 60 } }), at(5));
    for (const id of [northwind, kova]) expect((await k.as("ada", (tx, c) => rowHistory(tx, c, id))).map((i) => i.text)).toContain("Notice changed, with others");
  });

  it("is refused for someone who can't see the row", async () => {
    await expect(k.as("maya", (tx, c) => rowHistory(tx, c, northwind))).rejects.toThrow(/can't see it|doesn't exist/);
  });
});
