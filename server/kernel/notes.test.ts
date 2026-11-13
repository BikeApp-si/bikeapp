import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { kernelWorkspace } from "@/tests/kernel";
import { recordFile } from "@/tests/record";
import { addNote, NOTE_MAX } from "./notes";
import { createRow } from "./rows";

// Notes on a row (0.4, M22): by anyone who may see the row, fixed once posted, in the Audit log.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let northwind: string;

beforeAll(async () => {
  k = await kernelWorkspace();
  const cap = await k.create(recordFile([k.id.ada]));
  northwind = (await k.as("ada", (tx, c) => createRow(tx, c, cap, "contracts", { values: { customer: "Northwind", value: 3_840_000, owner: k.id.rita } }))).id;
});

describe("notes", () => {
  it("anyone who may see the row adds one, and it's in the Audit log", async () => {
    await k.as("rita", (tx, c) => addNote(tx, c, northwind, "  Called Dana, they want the same price.  "));
    const [entry] = await k.as("ada", (tx) =>
      tx.execute<{ event: string; details: { row: string }; row_ids: string[] }>(sql`select event, details, row_ids from audit_entries where event = 'row.noted'`),
    );
    expect(entry).toMatchObject({ event: "row.noted", details: { row: "Northwind" }, row_ids: [northwind] });
  });

  it("is refused for someone who can't see the row, and when empty or too long", async () => {
    await expect(k.as("maya", (tx, c) => addNote(tx, c, northwind, "Hello"))).rejects.toThrow(/can't see it|doesn't exist/);
    await expect(k.as("rita", (tx, c) => addNote(tx, c, northwind, "   "))).rejects.toThrow(/Write the note first/);
    await expect(k.as("rita", (tx, c) => addNote(tx, c, northwind, "x".repeat(NOTE_MAX + 1)))).rejects.toThrow(/under 2,000/);
  });
});
