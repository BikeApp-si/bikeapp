import { beforeAll, describe, expect, it } from "vitest";
import { kernelWorkspace } from "@/tests/kernel";
import { contractsFile } from "./fixtures";
import { createRow, listRows, sheetTotals } from "./rows";
import { deleteView, saveTablePrefs, saveView, tablePrefsFor, viewsFor, type ViewInput } from "./saved-views";

// Saved views, table preferences and search in a sheet (0.4, M19), as the kernel keeps them: a person's own views are
// theirs alone, a shared one is an admin's to make or change, a view never shows a row the person couldn't see, and
// search covers text, people, choices, steps and linked names.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let contracts: string;
const view = (v: Partial<ViewInput> = {}): ViewInput => ({ name: "Big deals", filters: [{ column: "value", op: "between", from: 2_000_000 }], sort: null, columns: null, shared: false, ...v });

beforeAll(async () => {
  k = await kernelWorkspace();
  contracts = await k.create(contractsFile([k.id.ada]));
  const add = (customer: string, value: number, owner: string) => k.as("ada", (tx, c) => createRow(tx, c, contracts, "contracts", { values: { customer, value, owner } }));
  await add("Northwind", 3_840_000, k.id.rita);
  await add("Kova", 1_080_000, k.id.rita);
  await add("Brightline 100% renewals_q4", 5_760_000, k.id.ada);
});

describe("saved views", () => {
  it("a person's own view is theirs alone", async () => {
    const mine = await k.as("rita", (tx, c) => saveView(tx, c, contracts, "contracts", view({ name: "My big deals" })));
    expect(mine).toMatchObject({ name: "My big deals", mine: true, shared: false });
    expect((await k.as("ada", (tx, c) => viewsFor(tx, c, contracts, "contracts"))).map((v) => v.name)).not.toContain("My big deals");
    await expect(k.as("ada", (tx, c) => saveView(tx, c, contracts, "contracts", view({ name: "Taken" }), mine.id))).rejects.toThrow(/doesn't exist, or you can't change it/);
    await expect(k.as("ada", (tx, c) => deleteView(tx, c, mine.id))).rejects.toThrow(/can't change it/);
  });

  it("only an admin of the capability shares a view; everyone who sees the sheet gets it, with only their rows", async () => {
    await expect(k.as("rita", (tx, c) => saveView(tx, c, contracts, "contracts", view({ shared: true })))).rejects.toThrow(/Only an admin/);
    const shared = await k.as("ada", (tx, c) => saveView(tx, c, contracts, "contracts", view({ shared: true })));
    const ritas = await k.as("rita", (tx, c) => viewsFor(tx, c, contracts, "contracts"));
    expect(ritas[0]).toMatchObject({ id: shared.id, shared: true, mine: false });
    // Opened, its filters run as the person: Ada sees both big deals, Rita only hers.
    const open = (who: "ada" | "rita") => k.as(who, (tx, c) => listRows(tx, c, contracts, "contracts", { filters: shared.filters })).then((r) => r.map((x) => x.data.customer).sort());
    expect(await open("ada")).toEqual(["Brightline 100% renewals_q4", "Northwind"]);
    expect(await open("rita")).toEqual(["Northwind"]);
    await expect(k.as("rita", (tx, c) => deleteView(tx, c, shared.id))).rejects.toThrow(/can't change it/);
    await k.as("ada", (tx, c) => deleteView(tx, c, shared.id));
  });

  it("refuses names that aren't the sheet's, and people who can't see the sheet", async () => {
    await expect(k.as("ada", (tx, c) => saveView(tx, c, contracts, "contracts", view({ filters: [{ column: "colour", op: "in", values: ["red"] }] })))).rejects.toThrow(/no such column/);
    await expect(k.as("ada", (tx, c) => saveView(tx, c, contracts, "contracts", view({ columns: { order: ["ghost"], hidden: [] } })))).rejects.toThrow(/no such column/);
    await expect(k.as("ada", (tx, c) => saveView(tx, c, contracts, "contracts", view({ name: " " })))).rejects.toThrow(/Give the view a name/);
    await expect(k.as("maya", (tx, c) => viewsFor(tx, c, contracts, "contracts"))).rejects.toThrow(/can't see it/);
  });
});

describe("table preferences", () => {
  it("are kept per person", async () => {
    const cols = { order: ["value", "customer"], hidden: ["notice"], widths: { customer: 240 }, frozen: true };
    await k.as("ada", (tx, c) => saveTablePrefs(tx, c, contracts, "contracts", cols));
    expect(await k.as("ada", (tx, c) => tablePrefsFor(tx, c, contracts, "contracts"))).toEqual(cols);
    expect(await k.as("rita", (tx, c) => tablePrefsFor(tx, c, contracts, "contracts"))).toBeNull();
    await k.as("ada", (tx, c) => saveTablePrefs(tx, c, contracts, "contracts", null));
    expect(await k.as("ada", (tx, c) => tablePrefsFor(tx, c, contracts, "contracts"))).toBeNull();
  });
});

describe("search in a sheet", () => {
  const find = (who: "ada" | "rita", q: string) => k.as(who, (tx, c) => listRows(tx, c, contracts, "contracts", { search: q })).then((r) => r.map((x) => x.data.customer).sort());
  it("matches text, a person's name and a step's name, case-insensitively", async () => {
    expect(await find("ada", "NORTH")).toEqual(["Northwind"]);
    expect(await find("ada", "rita")).toEqual(["Kova", "Northwind"]);
    expect((await find("ada", "draft")).length).toBe(3);
  });
  it("takes % and _ as themselves, and counts what it finds", async () => {
    expect(await find("ada", "100%")).toEqual(["Brightline 100% renewals_q4"]);
    expect(await find("ada", "s_q")).toEqual(["Brightline 100% renewals_q4"]);
    expect(await find("ada", "%")).toEqual(["Brightline 100% renewals_q4"]);
    expect((await k.as("ada", (tx, c) => sheetTotals(tx, c, contracts, "contracts", { search: "rita" }))).count).toBe(2);
  });
  it("never finds a row the person can't see", async () => {
    expect(await find("rita", "Brightline")).toEqual([]);
  });
});
