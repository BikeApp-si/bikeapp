import { uploads } from "@/db/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { kernelWorkspace } from "@/tests/kernel";
import type { CapabilityFile } from "./schema/file";
import { createRow } from "./rows";
import { openUpload, saveUpload } from "./uploads";

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let cap: string;
const pdf = new TextEncoder().encode("%PDF-1.7 signed");

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
        columns: [
          { id: "customer", name: "Customer", type: "text", required: true },
          { id: "owner", name: "Owner", type: "person" },
          { id: "signed", name: "Signed contract", type: "file" },
        ],
      },
    ],
    roles: [
      { id: "managers", name: "Managers", members: { kind: "people", people: [manager] }, can: ["see", "add", "edit"], scope: "all" },
      { id: "owners", name: "Owners", members: { kind: "column", sheet: "contracts", column: "owner" }, can: ["see"], scope: "own", scopeColumns: { contracts: { column: "owner" } } },
    ],
    rules: [],
    later: [],
  };
}

beforeAll(async () => {
  k = await kernelWorkspace();
  cap = await k.create(file(k.id.ada));
});

describe("uploads", () => {
  it("keeps the file and opens it for whoever can see the row that holds it", async () => {
    const up = await k.as("ada", (tx, c) => saveUpload(tx, c, { name: "Kova-MSA-2026.pdf", body: pdf }));
    await k.as("ada", (tx, c) => createRow(tx, c, cap, "contracts", { values: { customer: "Kova", owner: k.id.rita, signed: up.id } }));
    const opened = await k.as("rita", (tx, c) => openUpload(tx, c, up.id));
    expect(opened.name).toBe("Kova-MSA-2026.pdf");
    expect(opened.mime).toBe("application/pdf");
    expect(new TextDecoder().decode(opened.body)).toBe("%PDF-1.7 signed");
    await expect(k.as("priya", (tx, c) => openUpload(tx, c, up.id))).rejects.toThrow(/can't see it/);
    await expect(k.as("priya", (tx, c) => openUpload(tx, c, "not-an-id"))).rejects.toThrow(/can't see it/);
  });

  it("opens a file not yet in a row only for the person who uploaded it", async () => {
    const up = await k.as("maya", (tx, c) => saveUpload(tx, c, { name: "receipt.png", body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]) }));
    expect((await k.as("maya", (tx, c) => openUpload(tx, c, up.id))).mime).toBe("image/png");
    await expect(k.as("omar", (tx, c) => openUpload(tx, c, up.id))).rejects.toThrow(/can't see it/);
  });

  it("refuses files that aren't allowed, and files over 25 MB", async () => {
    await expect(k.as("ada", (tx, c) => saveUpload(tx, c, { name: "run.exe", body: pdf }))).rejects.toThrow(/PDF, Word, Markdown, Excel, CSV, zip, PNG and JPG/);
    await expect(k.as("ada", (tx, c) => saveUpload(tx, c, { name: "big.pdf", body: new Uint8Array(25 * 1024 * 1024 + 1) }))).rejects.toThrow(/over 25 MB/);
  });

  it("refuses a file that isn't what its name says, and one with a virus; neither is kept (M9)", async () => {
    const before = await k.as("ada", (tx) => tx.select().from(uploads));
    await expect(k.as("ada", (tx, c) => saveUpload(tx, c, { name: "invoice.pdf", body: new TextEncoder().encode("MZ this is a program") }))).rejects.toThrow("That file isn't the kind its name says.");
    await expect(k.as("ada", (tx, c) => saveUpload(tx, c, { name: "photo.jpg", body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]) }))).rejects.toThrow("That file isn't the kind its name says.");
    await expect(k.as("ada", (tx, c) => saveUpload(tx, c, { name: "list.csv", body: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]) }))).rejects.toThrow("That file isn't the kind its name says.");
    // EICAR, the standard harmless test file every scanner reports as a virus, inside a CSV.
    const eicar = new TextEncoder().encode("Name\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*\n");
    await expect(k.as("ada", (tx, c) => saveUpload(tx, c, { name: "list.csv", body: eicar }))).rejects.toThrow("That file didn't pass the virus check, so it wasn't added.");
    expect(await k.as("ada", (tx) => tx.select().from(uploads))).toHaveLength(before.length);
    // A CSV exported in Windows-1252 is still text.
    await k.as("ada", (tx, c) => saveUpload(tx, c, { name: "café.csv", body: new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x0a]) }));
  });
});
