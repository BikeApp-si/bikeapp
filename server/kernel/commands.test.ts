import { beforeAll, describe, expect, it } from "vitest";
import { kernelWorkspace } from "@/tests/kernel";
import { commandIndex, findRows } from "./commands";
import { contractsFile } from "./fixtures";
import { createRow } from "./rows";

// ⌘K (0.4, M21) reaches only what the person may see: capabilities, the rows they can add, the sidebar's pages
// (admins' pages for admins), and rows found by a few letters inside each sheet's own access.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let contracts: string;

beforeAll(async () => {
  k = await kernelWorkspace();
  contracts = await k.create(contractsFile([k.id.ada]));
  const add = (customer: string, owner: string) => k.as("ada", (tx, c) => createRow(tx, c, contracts, "contracts", { values: { customer, value: 1_000_000, owner } }));
  await add("Northwind", k.id.rita);
  await add("Northgate", k.id.ada);
  await add("Kova", k.id.rita);
});

describe("what ⌘K lists", () => {
  it("an admin gets the capability, its add action and every page", async () => {
    const i = await k.as("ada", (tx, c) => commandIndex(tx, c));
    expect(i.capabilities.map((c) => [c.name, c.sheets.map((s) => s.name)])).toEqual([["Customer contracts", ["Contracts"]]]);
    expect(i.actions.map((a) => a.label)).toContain("Add a person");
    expect(i.pages.map((p) => p.label)).toEqual(["Home", "Inbox", "Chats", "People", "Audit log", "Ontology", "Settings"]);
  });

  it("an owner sees the capability but can't add; a person outside it sees neither; neither gets admins' pages", async () => {
    const rita = await k.as("rita", (tx, c) => commandIndex(tx, c));
    expect(rita.capabilities.map((c) => c.name)).toEqual(["Customer contracts"]);
    expect(rita.actions).toEqual([]);
    expect(rita.pages.map((p) => p.label)).toEqual(["Home", "Inbox", "People"]);
    const maya = await k.as("maya", (tx, c) => commandIndex(tx, c));
    expect(maya.capabilities).toEqual([]);
  });
});

describe("rows found by ⌘K", () => {
  const find = (who: "ada" | "rita" | "maya", q: string) => k.as(who, (tx, c) => findRows(tx, c, q)).then((r) => r.map((x) => x.title).sort());
  it("finds by a few letters, with the capability, sheet and step", async () => {
    expect(await find("ada", "north")).toEqual(["Northgate", "Northwind"]);
    const [one] = await k.as("ada", (tx, c) => findRows(tx, c, "kova"));
    expect(one).toMatchObject({ title: "Kova", capability: "Customer contracts", sheet: "Contracts", step: "Draft" });
  });
  it("finds only rows the person may see", async () => {
    expect(await find("rita", "north")).toEqual(["Northwind"]);
    expect(await find("maya", "north")).toEqual([]);
  });
  it("needs two letters", async () => {
    expect(await find("ada", "n")).toEqual([]);
  });
});
