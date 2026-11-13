import { beforeAll, describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { kernelWorkspace } from "@/tests/kernel";
import type { CapabilityFile } from "./schema/file";
import { capabilitiesFor, deleteCapability, deleteImpact } from "./capabilities";
import { exportCapability } from "./export";
import { createRow, deletePreview, getRow, listRows } from "./rows";
import { saveUpload } from "./uploads";
import { capabilityView, namesFor } from "./views";

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let cap: string;
let other: string;

// Contracts with contacts; managers see all, owners their own contracts and those contracts' contacts.
function file(manager: string): CapabilityFile {
  return {
    name: "Customer contracts",
    icon: "file-pen-line",
    sheets: [
      {
        id: "contracts",
        name: "Contracts",
        kind: "list",
        titleColumn: "customer",
        row: { one: "contract", many: "contracts" },
        columns: [
          { id: "customer", name: "Customer", type: "text", required: true },
          { id: "value", name: "Value a year", type: "money" },
          { id: "owner", name: "Owner", type: "person" },
          { id: "signed", name: "Signed contract", type: "file" },
        ],
      },
      {
        id: "contacts",
        name: "Contacts",
        kind: "list",
        titleColumn: "name",
        row: { one: "contact", many: "contacts" },
        columns: [
          { id: "contract", name: "Contract", type: "link", link: { sheet: "contracts" }, required: true },
          { id: "name", name: "Name", type: "text", required: true },
        ],
      },
    ],
    roles: [
      { id: "managers", name: "Contract managers", members: { kind: "people", people: [manager] }, can: ["see", "add", "edit", "delete"], scope: "all" },
      {
        id: "owners",
        name: "Contract owners",
        members: { kind: "column", sheet: "contracts", column: "owner" },
        can: ["see"],
        sheets: ["contracts"],
        scope: "own",
        scopeColumns: { contracts: { column: "owner" } },
      },
    ],
    rules: [],
    later: [],
  };
}

beforeAll(async () => {
  k = await kernelWorkspace();
  cap = await k.create(file(k.id.ada));
  const signed = await k.as("ada", (tx, c) => saveUpload(tx, c, { name: "Kova-MSA-2026.pdf", body: new TextEncoder().encode("%PDF-1.7") }));
  const add = (values: Record<string, unknown>, sheet = "contracts") => k.as("ada", (tx, c) => createRow(tx, c, cap, sheet, { values })).then((r) => r.id);
  const kova = await add({ customer: "Kova", value: 1_080_000, owner: k.id.rita, signed: signed.id });
  const north = await add({ customer: "Northwind, Inc", value: 3_840_000, owner: k.id.priya });
  await add({ contract: kova, name: "Jun Park" }, "contacts");
  await add({ contract: north, name: "=SUM(A1)" }, "contacts");
  other = await k.create({ ...file(k.id.ada), name: "Other" });
});

describe("capability view", () => {
  it("shows the sheets the person can see, with counts and names", async () => {
    const ada = await k.as("ada", (tx, c) => capabilityView(tx, c, cap));
    expect(ada.sheets.map((s) => [s.name, s.count, s.addAction])).toEqual([["Contracts", 2, "New contract"], ["Contacts", 2, "New contact"]]);
    // Created today, so it says so (5i); an older one has its date ("Created Aug 12 from your message", 6a).
    expect(ada.line).toBe("Created from your documents today · owned by Ada Admin");
    const rita = await k.as("rita", (tx, c) => capabilityView(tx, c, cap));
    expect(rita.sheets.map((s) => [s.name, s.count, s.canAdd])).toEqual([["Contracts", 1, false]]);
    await expect(k.as("maya", (tx, c) => capabilityView(tx, c, cap))).rejects.toThrow(/can't see it/);
  });

  it("names linked rows and files", async () => {
    const view = await k.as("ada", (tx, c) => capabilityView(tx, c, cap));
    const contacts = await k.as("ada", (tx, c) => listRows(tx, c, cap, "contacts"));
    const names = await k.as("ada", (tx, c) => namesFor(tx, c, { ...view.sheets[1]!, columns: file(k.id.ada).sheets[1]!.columns } as never, contacts));
    expect(Object.values(names.rows).sort()).toEqual(["Kova", "Northwind, Inc"]);
    const contracts = await k.as("ada", (tx, c) => listRows(tx, c, cap, "contracts"));
    const files = await k.as("ada", (tx, c) => namesFor(tx, c, file(k.id.ada).sheets[0]!, contracts));
    expect(Object.values(files.files)).toEqual(["Kova-MSA-2026.pdf"]);
  });
});

describe("export", () => {
  it("zips one CSV per sheet, with names in place of ids", async () => {
    const out = await k.as("ada", (tx, c) => exportCapability(tx, c, cap));
    expect(out).toMatchObject({ name: "customer-contracts.zip", mime: "application/zip" });
    const files = unzipSync(out.body);
    expect(Object.keys(files)).toEqual(["customer-contracts-contracts.csv", "customer-contracts-contacts.csv"]);
    expect(strFromU8(files["customer-contracts-contracts.csv"]!).trim().split(/\r?\n/)).toEqual([
      "Customer,Value a year,Owner,Signed contract",
      "Kova,\"$10,800\",Rita Gomez,Kova-MSA-2026.pdf",
      "\"Northwind, Inc\",\"$38,400\",Priya Nair,",
    ]);
    // A value a spreadsheet would run as a formula is written as text.
    expect(strFromU8(files["customer-contracts-contacts.csv"]!)).toContain("\"Northwind, Inc\",'=SUM(A1)");
  });

  it("exports only what the person can see, as one CSV", async () => {
    const out = await k.as("rita", (tx, c) => exportCapability(tx, c, cap));
    expect(out.name).toBe("customer-contracts-contracts.csv");
    expect(new TextDecoder().decode(out.body).trim().split(/\r?\n/)).toHaveLength(2);
    await expect(k.as("maya", (tx, c) => exportCapability(tx, c, cap))).rejects.toThrow(/can't see it/);
  });
});

describe("before deleting rows (7e)", () => {
  it("names the rows and counts what goes with them", async () => {
    const contracts = await k.as("ada", (tx, c) => listRows(tx, c, cap, "contracts"));
    const preview = await k.as("ada", (tx, c) => deletePreview(tx, c, contracts.map((r) => r.id)));
    expect(preview.rows.map((r) => r.title)).toEqual(["Kova", "Northwind, Inc"]);
    expect(preview.alsoDeleted).toEqual([{ one: "contact", many: "contacts", count: 2 }]);
    await expect(k.as("rita", (tx, c) => deletePreview(tx, c, [contracts[0]!.id]))).rejects.toThrow(/can't do that/);
  });
});

describe("delete a capability", () => {
  it("says what goes: rows per sheet, files and who loses access", async () => {
    const impact = await k.as("ada", (tx, c) => deleteImpact(tx, c, cap));
    expect(impact).toMatchObject({
      name: "Customer contracts",
      sheets: [{ name: "Contracts", count: 2 }, { name: "Contacts", count: 2 }],
      files: 1,
      connections: [{ direction: "into", capability: "People", text: "People fills Owner" }],
    });
    expect([...(impact.loseAccess as string[])].sort()).toEqual(["Priya Nair", "Rita Gomez"]);
    await expect(k.as("maya", (tx, c) => deleteImpact(tx, c, cap))).rejects.toThrow(/Only admins/);
  });

  it("needs the name typed, then makes it and its rows invisible", async () => {
    const [kova] = await k.as("ada", (tx, c) => listRows(tx, c, cap, "contracts"));
    await expect(k.as("ada", (tx, c) => deleteCapability(tx, c, cap, "customer contracts"))).rejects.toThrow(/Type Customer contracts to confirm/);
    await k.as("ada", (tx, c) => deleteCapability(tx, c, cap, " Customer contracts "));
    expect((await k.as("ada", (tx, c) => capabilitiesFor(tx, c))).map((x) => x.id)).toEqual([other]);
    expect(await k.as("ada", (tx, c) => listRows(tx, c, cap, "contracts"))).toEqual([]);
    await expect(k.as("ada", (tx, c) => getRow(tx, c, kova!.id))).rejects.toThrow(/can't see it/);
  });
});
