import { beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, isNull } from "drizzle-orm";
import { auditEntries, capabilities, changeSets, people, rows } from "@/db/schema";
import { seedWorkspace } from "@/seed";
import { seedCapabilities } from "@/seed/capabilities";
import { FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES } from "@/seed/fernwood";
import { createCapability, getFile } from "../capabilities";
import type { KernelCtx } from "../context";
import { salesLeadsFile } from "../fixtures";
import { rowHistory } from "../history";
import { createRow, deleteRows, updateRow } from "../rows";
import type { CapabilityFile } from "../schema/file";
import { withWorkspace, type Tx } from "../tx";
import { applyCustomize, previewCustomize, type Edits } from "./apply";
import { applyChanges, type Change } from "./changes";
import { keptName, linkInstead, movesOf } from "./link-instead";

// M27: a typed customer name turned into a link to Customers, on the seeded Fernwood (12 contracts). The kernel
// matches, previews and moves; nothing is guessed, and the typed values are kept, read only.

const NOW = new Date("2026-10-27T15:00:00Z");
let ws: string;
const ids = new Map<string, string>();
const ctx = (n: string): KernelCtx => ({ workspaceId: ws, actor: { id: ids.get(n)!, email: `${n}@fernwood.dev` }, now: NOW });
const as = <T>(n: string, fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: ws, personId: ids.get(n) }, (tx) => fn(tx, ctx(n)));
const capNamed = (name: string) => as("wade", (tx) => tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, name))).then((r) => r[0]!.id);
const fileOf = (id: string) => as("wade", (tx) => getFile(tx, id)).then((f) => f!);
const edits = (capId: string, before: CapabilityFile, changes: Change[]): Edits => new Map([[capId, { before, after: applyChanges(before, changes), changes: ["Customer becomes a link to Customers"] }]]);
const liveRows = (capId: string, sheet: string) =>
  as("wade", (tx) => tx.select().from(rows).where(and(eq(rows.capabilityId, capId), eq(rows.sheetId, sheet), isNull(rows.deletedAt))).orderBy(asc(rows.seq)));

const customersFile: CapabilityFile = {
  name: "Customers",
  icon: "building-2",
  sheets: [{ id: "customers", name: "Customers", kind: "list", row: { one: "customer", many: "customers" }, titleColumn: "name", columns: [{ id: "name", name: "Name", type: "text", required: true }] }],
  roles: [],
  rules: [],
  later: [],
};
const withManagers = (wade: string): CapabilityFile => ({ ...customersFile, roles: [{ id: "managers", name: "Customer managers", members: { kind: "people", people: [wade] }, can: ["see", "add", "edit", "delete", "customize"], scope: "all" }] });

const NAMES = ["Northwind", "acme health", "Pinecone  Labs", "Orbit Health", "Brightline", "Kova", "Lumen Retail", "Harbor Logistics", "Sable Analytics", "Fieldstone", "Cedar Freight"];

let contracts: string;
let customers: string;
const linkChange = (): Change => ({ kind: "link_column", sheet: "contracts", column: "customer", to: { capability: customers, sheet: "customers" } });

beforeAll(async () => {
  ws = (await seedWorkspace({ subdomain: `mv${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
  await seedCapabilities(ws);
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    for (const p of await tx.select({ id: people.id, email: people.email }).from(people)) ids.set(p.email.split("@")[0]!, p.id);
  });
  contracts = await capNamed("Customer contracts");
  customers = (await as("wade", (tx, c) => createCapability(tx, c, withManagers(ids.get("wade")!), { source: "plan" }))).id;
  // Every customer but Quill Media, two of them typed differently from the contracts.
  for (const name of NAMES) await as("wade", (tx, c) => createRow(tx, c, customers, "customers", { values: { name } }));
});

describe("the file change", () => {
  it("puts a link in the typed column's place, name and title, and keeps the typed column read only", async () => {
    const before = (await fileOf(contracts)).file;
    const after = linkInstead(before, { sheet: "contracts", column: "customer", to: { capability: customers, sheet: "customers" } });
    const sheet = after.sheets.find((s) => s.id === "contracts")!;
    const link = sheet.columns[0]!;
    expect(link).toMatchObject({ name: "Customer", type: "link", required: true, link: { capability: customers, sheet: "customers" } });
    expect(sheet.columns.at(-1)).toEqual({ id: "customer", name: keptName("Customer"), type: "text", replacedBy: link.id });
    expect(sheet.titleColumn).toBe(link.id);
    expect(sheet.form!.tabs[0]!.sections[0]!.columns).toEqual([link.id, "value", "owner"]);
    expect(movesOf(contracts, before, after)).toEqual([{ capabilityId: contracts, sheet: "contracts", from: "customer", to: link.id }]);
    expect(movesOf(contracts, after, after)).toEqual([]);
    expect(before.sheets[0]!.columns[0]!.name).toBe("Customer"); // the file passed in is never changed
  });

  it("only turns typed text into a link", async () => {
    const before = (await fileOf(contracts)).file;
    expect(() => linkInstead(before, { sheet: "contracts", column: "value", to: { capability: customers, sheet: "customers" } })).toThrow("isn't typed text");
  });
});

describe("Customer contracts: Customer becomes a link to Customers", () => {
  const chatId = crypto.randomUUID();
  let applied: Edits;

  it("can't be applied while one contract's customer isn't in Customers, and lists it", async () => {
    const v = await fileOf(contracts);
    const e = edits(contracts, v.file, [linkChange()]);
    const p = await as("wade", (tx, c) => previewCustomize(tx, c, contracts, e, chatId));
    expect(p.problems).toEqual([]);
    const [m] = p.moves;
    expect(m).toMatchObject({ capability: "Customer contracts", sheet: "Contracts", column: "Customer", kept: "Customer, as typed", target: "Customers", rows: 12, created: [], empty: 0 });
    expect(m!.linked).toHaveLength(11);
    expect(m!.cantMap).toEqual([{ row: "Quill Media", value: "Quill Media", why: "No customer is called “Quill Media”." }]);
    // Matched without regard to case or spacing.
    expect(m!.linked.find((l) => l.value === "Pinecone Labs")!.toName).toBe("Pinecone  Labs");

    await expect(as("wade", (tx, c) => applyCustomize(tx, c, contracts, e, chatId))).rejects.toThrow("1 contract can't be linked to Customers, so nothing was moved.");
    expect((await fileOf(contracts)).version).toBe(v.version);
    const linkId = e.get(contracts)!.after.sheets[0]!.titleColumn;
    expect((await liveRows(contracts, "contracts")).some((r) => linkId in (r.data as object))).toBe(false);
  });

  it("can't link a name two customers share", async () => {
    const quill = await as("wade", (tx, c) => createRow(tx, c, customers, "customers", { values: { name: "Quill Media" } }));
    const twin = await as("wade", (tx, c) => createRow(tx, c, customers, "customers", { values: { name: "  KOVA " } }));
    const e = edits(contracts, (await fileOf(contracts)).file, [linkChange()]);
    const p = await as("wade", (tx, c) => previewCustomize(tx, c, contracts, e, chatId));
    expect(p.moves[0]!.cantMap).toEqual([{ row: "Kova", value: "Kova", why: "2 customers are called “Kova”." }]);
    await as("wade", (tx, c) => deleteRows(tx, c, [twin.id]));
    expect(quill.id).toBeTruthy();
  });

  it("previews the same thing twice from the same rows", async () => {
    const e = edits(contracts, (await fileOf(contracts)).file, [linkChange()]);
    const a = await as("wade", (tx, c) => previewCustomize(tx, c, contracts, e, chatId));
    const b = await as("wade", (tx, c) => previewCustomize(tx, c, contracts, e, chatId));
    expect(a.moves).toEqual(b.moves);
    expect(a.moves[0]!.linked).toHaveLength(12);
    expect(a.moves[0]!.cantMap).toEqual([]);
  });

  it("is for admins only, in the kernel", async () => {
    const e = edits(contracts, (await fileOf(contracts)).file, [linkChange()]);
    await expect(as("maya", (tx, c) => previewCustomize(tx, c, contracts, e, chatId))).rejects.toThrow(/Only admins/);
    await expect(as("maya", (tx, c) => applyCustomize(tx, c, contracts, e, chatId))).rejects.toThrow(/Only admins/);
  });

  it("moves every contract in one change set, keeps what was typed, and logs it", async () => {
    const v = await fileOf(contracts);
    const e = edits(contracts, v.file, [linkChange()]);
    applied = e;
    const before = await liveRows(contracts, "contracts");
    const { changeSetId, versions } = await as("wade", (tx, c) => applyCustomize(tx, c, contracts, e, chatId, "Customer as a link"));
    expect(versions.get(contracts)).toBe(v.version + 1);
    const [cs] = await as("wade", (tx) => tx.select().from(changeSets).where(eq(changeSets.id, changeSetId)));
    expect(cs!.kind).toBe("restructure");

    const linkId = (await fileOf(contracts)).file.sheets[0]!.titleColumn;
    const names = new Map((await liveRows(customers, "customers")).map((r) => [r.id, (r.data as { name: string }).name.trim().toLowerCase().replace(/\s+/g, " ")]));
    const after = await liveRows(contracts, "contracts");
    expect(after).toHaveLength(12);
    for (const r of after) {
      const d = r.data as Record<string, string>;
      const was = before.find((b) => b.id === r.id)!.data as Record<string, string>;
      expect(d.customer).toBe(was.customer); // kept as typed
      expect(names.get(d[linkId]!)).toBe(d.customer!.toLowerCase());
      expect(r.fileVersion).toBe(v.version + 1);
    }

    const [moved] = await as("wade", (tx) => tx.select().from(auditEntries).where(and(eq(auditEntries.changeSetId, changeSetId), eq(auditEntries.event, "changeset.moved"))));
    expect(moved!.details).toEqual({ sheet: "Contracts", change: "Customer, as typed → Customer, linked to Customers", linked: 12 });
    expect(moved!.rowIds).toHaveLength(12);
    const history = await as("wade", (tx, c) => rowHistory(tx, c, after[0]!.id));
    expect(history.map((h) => h.text)).toContain("Customer, as typed → Customer, linked to Customers");
  });

  it("keeps the typed column read only", async () => {
    const [first] = await liveRows(contracts, "contracts");
    const typed = (first!.data as { customer: string }).customer;
    await expect(as("wade", (tx, c) => updateRow(tx, c, first!.id, { customer: "Renamed" }))).rejects.toThrow("Customer, as typed is kept from before and can't be changed.");
    await as("wade", (tx, c) => updateRow(tx, c, first!.id, { customer: typed, value: 4_000_000 })); // sent back unchanged: fine
  });

  it("refuses an Apply from a preview made before the move", async () => {
    await expect(as("wade", (tx, c) => applyCustomize(tx, c, contracts, applied, chatId))).rejects.toThrow("has changed since this preview");
  });

  it("never lets a later change drop the kept column or point the link elsewhere", async () => {
    const v = await fileOf(contracts);
    const sheet = v.file.sheets[0]!;
    const dropped = structuredClone(v.file);
    delete dropped.sheets[0]!.columns.find((c) => c.id === "customer")!.replacedBy;
    const e: Edits = new Map([[contracts, { before: v.file, after: dropped, changes: ["x"] }]]);
    const p = await as("wade", (tx, c) => previewCustomize(tx, c, contracts, e, chatId));
    expect(p.problems.join(" ")).toContain("Customer, as typed is kept from before and stays as it is.");
    const elsewhere = structuredClone(v.file);
    elsewhere.sheets[0]!.columns.find((c) => c.id === sheet.titleColumn)!.link = { sheet: "renewals" };
    const e2: Edits = new Map([[contracts, { before: v.file, after: elsewhere, changes: ["x"] }]]);
    expect((await as("wade", (tx, c) => previewCustomize(tx, c, contracts, e2, chatId))).problems.join(" ")).toContain("would point somewhere else");
  });
});

describe("a link to a sheet added in the same change", () => {
  it("adds one row per name, then links each lead to it", async () => {
    const leads = (await as("wade", (tx, c) => createCapability(tx, c, salesLeadsFile([ids.get("wade")!]), { source: "plan" }))).id;
    for (const company of ["Northwind", "Kova", "northwind ", "Lumen"]) await as("wade", (tx, c) => createRow(tx, c, leads, "leads", { values: { company } }));
    const v = await fileOf(leads);
    const changes: Change[] = [
      { kind: "add_sheet", sheet: { id: "companies", name: "Companies", kind: "list", row: { one: "company", many: "companies" }, titleColumn: "name", columns: [{ id: "name", name: "Name", type: "text", required: true }] } },
      { kind: "link_column", sheet: "leads", column: "company", to: { sheet: "companies" } },
    ];
    const e: Edits = new Map([[leads, { before: v.file, after: applyChanges(v.file, changes), changes: ["Companies"] }]]);
    const p = await as("wade", (tx, c) => previewCustomize(tx, c, leads, e, crypto.randomUUID()));
    expect(p.moves[0]).toMatchObject({ rows: 4, created: ["Northwind", "Kova", "Lumen"], cantMap: [] });
    await as("wade", (tx, c) => applyCustomize(tx, c, leads, e, crypto.randomUUID()));
    const made = await liveRows(leads, "companies");
    expect(made.map((r) => (r.data as { name: string }).name)).toEqual(["Northwind", "Kova", "Lumen"]);
    const linkId = (await fileOf(leads)).file.sheets.find((s) => s.id === "leads")!.titleColumn;
    const linked = (await liveRows(leads, "leads")).map((r) => (r.data as Record<string, string>)[linkId]);
    expect(linked).toEqual([made[0]!.id, made[1]!.id, made[0]!.id, made[2]!.id]);
  });
});
