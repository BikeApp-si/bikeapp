import { beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { auditEntries, capabilities, changeSets, people } from "@/db/schema";
import { seedCapabilities } from "@/seed/capabilities";
import { FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES } from "@/seed/fernwood";
import { seedWorkspace } from "@/seed";
import { getFile, saveVersion } from "./capabilities";
import { applyPlan } from "./changesets";
import type { KernelCtx } from "./context";
import { planContext } from "./plans/context";
import type { DraftAlsoChange, DraftCapability } from "./plans/draft";
import { alsoChanges, billRules, bills, col, contractRules, contracts, J } from "./plans/fixtures";
import { checkPlan, type PlanInput } from "./plans/plan";
import { createRow, getRow, listRows, moveStep, saveDocument, updateRow } from "./rows";
import { withWorkspace, type Tx } from "./tx";

// Create: a checked plan applied as one change set (5h, 5j), on a Fernwood without Customer contracts.

let ws: string;
const ids = new Map<string, string>();
const ctx = (n: string): KernelCtx => ({ workspaceId: ws, actor: { id: ids.get(n)!, email: `${n}@fernwood.dev` } });
const as = <T>(n: string, fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: ws, personId: ids.get(n) }, (tx) => fn(tx, ctx(n)));
const capNamed = (name: string) => as("wade", (tx) => tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, name))).then((r) => r[0]?.id);

// The plan checked against the workspace as Wade sees it now.
const checked = (input: PlanInput, newId: string) =>
  as("wade", async (tx, c) => {
    const pc = await planContext(tx, c);
    return checkPlan(input, { newId, files: pc.files, people: pc.peopleByEmail });
  });

beforeAll(async () => {
  const sub = `fw${Date.now().toString(36)}`;
  ws = (await seedWorkspace({ subdomain: sub, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
  await seedCapabilities(ws, { contracts: false });
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    for (const p of await tx.select({ id: people.id, email: people.email }).from(people)) ids.set(p.email.split("@")[0]!, p.id);
  });
});

describe("Create, as one change set", () => {
  const contractsId = crypto.randomUUID();

  it("creates Customer contracts with its imported rows; the Audit log points to the change set and the chat", async () => {
    const chatId = crypto.randomUUID();
    const plan = await checked({ capability: contracts, rules: contractRules, alsoChanges: [] }, contractsId);
    const row = (customer: string, value: number, owner: string, status: string) => ({ values: { customer, value_a_year: value, start: "2026-03-01", owner: ids.get(owner), status } });
    const out = await as("wade", (tx, c) =>
      applyPlan(tx, c, { plan, newId: contractsId, chatId, changes: new Map(), imports: [{ sheetId: "contracts", fileName: "contracts.csv", rows: [row("Northwind", 3_840_000, "krishna", "active"), row("Kova", 1_200_000, "rita", "signed")] }] }),
    );
    expect(out.capabilityId).toBe(contractsId);
    const list = await as("wade", (tx, c) => listRows(tx, c, contractsId, "contracts"));
    expect(list.map((r) => [r.data.customer, r.stepId, r.data.renews_on])).toEqual([["Northwind", "active", "2027-03-01"], ["Kova", "signed", "2027-03-01"]]);
    const [cs] = await as("wade", (tx) => tx.select().from(changeSets).where(eq(changeSets.id, out.changeSetId)));
    expect(cs).toMatchObject({ source: "plan", chatId, items: [{ capabilityId: contractsId, fromVersion: 0, toVersion: 1 }] });
    const entries = await as("wade", (tx) => tx.select().from(auditEntries).where(eq(auditEntries.changeSetId, out.changeSetId)).orderBy(asc(auditEntries.seq)));
    expect(entries.map((e) => [e.event, e.chatId])).toEqual([["capability.created", chatId], ["import.done", chatId]]);
    expect(entries[1]!.details).toEqual({ file: "contracts.csv", rows: 2 });
  });

  it("is refused when it is created twice", async () => {
    const plan = await checked({ capability: { ...contracts, name: "Contracts again" }, rules: [], alsoChanges: [] }, contractsId);
    await expect(as("wade", (tx, c) => applyPlan(tx, c, { plan, newId: contractsId, chatId: crypto.randomUUID(), changes: new Map() }))).rejects.toThrow(
      "Contracts again has already been created.",
    );
  });

  it("creates Supplier bills with its 3 Also changes in Spend and Tools and budgets, and the rules then work across them", async () => {
    const [spendId, toolsId] = [await capNamed("Spend"), await capNamed("Tools and budgets")];
    // A budget that exists before Create: its new Spent is worked out in the same change set.
    const eng = await as("wade", (tx, c) => createRow(tx, c, toolsId!, "budgets", { values: { team: "engineering", quarter: "Q4", budget: 5_000_000 } }));
    const billsId = crypto.randomUUID();
    const plan = await checked({ capability: bills, rules: billRules, alsoChanges }, billsId);
    expect(plan.problems).toEqual([]);
    const changes = new Map([[spendId!, ["Add a Received quantity column", "Add a Billed step after Received"]], [toolsId!, ["Add a Spent column next to each budget"]]]);
    const out = await as("wade", (tx, c) => applyPlan(tx, c, { plan, newId: billsId, chatId: crypto.randomUUID(), changes }));

    const [cs] = await as("wade", (tx) => tx.select().from(changeSets).where(eq(changeSets.id, out.changeSetId)));
    expect((cs!.items as { capabilityId: string }[]).map((i) => i.capabilityId).sort()).toEqual([billsId, spendId, toolsId].sort());
    const applied = await as("wade", (tx) =>
      tx.select({ capabilityId: auditEntries.capabilityId, details: auditEntries.details }).from(auditEntries).where(and(eq(auditEntries.changeSetId, out.changeSetId), eq(auditEntries.event, "changeset.applied"))),
    );
    expect(applied.find((e) => e.capabilityId === spendId)!.details).toMatchObject({ changes: "Add a Received quantity column; Add a Billed step after Received" });
    expect((await as("wade", (tx, c) => getRow(tx, c, eng.id))).data.spent).toBe(0);
    expect((await as("wade", (tx) => getFile(tx, spendId!)))!.version).toBe(2);

    // A purchase Wade asked for, approved, ordered and received by Krishna; its bill is matched, then paid.
    const po = await as("wade", (tx, c) => saveDocument(tx, c, spendId!, "purchases", { values: { what: "Laptops", team: "engineering" } }, [{ values: { item: "Laptop", quantity: 2, unit_price: 150_000 } }]));
    for (const step of ["approved", "ordered", "received"]) await as("krishna", (tx, c) => moveStep(tx, c, po.id, step));
    const bill = await as("lena", (tx, c) => createRow(tx, c, billsId, "bills", { values: { supplier: "Acme", bill_number: "INV-1", amount: 301_000, purchase: po.id, budget: eng.id } }));
    expect((await as("lena", (tx, c) => getRow(tx, c, bill.id))).stepId).toBe("matched"); // within 2% of $3,000
    await as("lena", (tx, c) => moveStep(tx, c, bill.id, "approved"));
    await as("lena", (tx, c) => moveStep(tx, c, bill.id, "paid"));
    expect((await as("wade", (tx, c) => getRow(tx, c, po.id))).stepId).toBe("billed");
    expect((await as("wade", (tx, c) => getRow(tx, c, eng.id))).data.spent).toBe(301_000);
  });

  it("applies a plan whose parts read each other: a new app adds up rows by a link its Also change adds", async () => {
    const accountsId = crypto.randomUUID();
    const accounts: DraftCapability = {
      name: "Accounts", icon: "building-2",
      sheets: [{ name: "Accounts", kind: "list", parent_sheet: null, title_column: "Name", row_one: "account", row_many: "accounts", add_action: null, steps: [],
        columns: [col("Name", "text", { required: true }), col("Contract total", "computed", { result: "money", formula: J({ sumOf: { capability: "Customer contracts", sheet: "Contracts", column: "Value a year", by: "Account" } }) })] }],
      roles: [{ name: "Account managers", people: ["wade@fernwood.dev"], person_column: null, everyone: false, can: ["see", "add", "edit"], scope: "all", scope_columns: [], sheets: null }],
      later: [],
    };
    const link: DraftAlsoChange = { capability: "Customer contracts", sheet: "Contracts", change: "Add an Account column", reason: "So each contract points at its account", kind: "add",
      edits: [{ kind: "add_column", sheet: "Contracts", column: col("Account", "link", { link: { capability: "Accounts", sheet: "Accounts" } }), step: null, after: null, role: null, person: null, link: null }] };
    const plan = await checked({ capability: accounts, rules: [], alsoChanges: [link] }, accountsId);
    expect(plan.problems).toEqual([]);
    await as("wade", (tx, c) => applyPlan(tx, c, { plan, newId: accountsId, chatId: crypto.randomUUID(), changes: new Map() }));
    const acme = await as("wade", (tx, c) => createRow(tx, c, accountsId, "accounts", { values: { name: "Northwind" } }));
    const nw = (await as("wade", (tx, c) => listRows(tx, c, contractsId, "contracts"))).find((r) => r.data.customer === "Northwind")!;
    await as("wade", (tx, c) => updateRow(tx, c, nw.id, { account: acme.id }));
    expect((await as("wade", (tx, c) => getRow(tx, c, acme.id))).data.contract_total).toBe(3_840_000);
  });

  it("creates Customers from the names typed on contracts and links each contract to its customer (5l, M27)", async () => {
    const customersId = crypto.randomUUID();
    const customers: DraftCapability = {
      name: "Customers", icon: "building-2",
      sheets: [{ name: "Customers", kind: "list", parent_sheet: null, title_column: "Name", row_one: "customer", row_many: "customers", add_action: null, steps: [],
        columns: [col("Name", "text", { required: true }), col("Yearly value", "computed", { result: "money", formula: J({ sumOf: { capability: "Customer contracts", sheet: "Contracts", column: "Value a year", by: "Customer" } }) })] }],
      roles: [{ name: "Customer managers", people: ["wade@fernwood.dev"], person_column: null, everyone: false, can: ["see", "add", "edit"], scope: "all", scope_columns: [], sheets: null }],
      later: [],
    };
    const move: DraftAlsoChange = { capability: "Customer contracts", sheet: "Contracts", change: "Turn each contract's typed customer into a link to its row in Customers", reason: "So a customer shows all its contracts", kind: "restructure",
      edits: [{ kind: "link_column", sheet: "Contracts", column: null, step: null, after: null, role: null, person: null, link: { column: "Customer", to_capability: "Customers", to_sheet: "Customers" } }] };
    const plan = await checked({ capability: customers, rules: [], alsoChanges: [move] }, customersId);
    expect(plan.problems).toEqual([]);
    expect(plan.restructures).toEqual([]);
    const typed = (await as("wade", (tx, c) => listRows(tx, c, contractsId, "contracts"))).map((r) => r.data.customer);
    const out = await as("wade", (tx, c) => applyPlan(tx, c, { plan, newId: customersId, chatId: crypto.randomUUID(), changes: new Map([[contractsId, [move.change]]]) }));
    const [cs] = await as("wade", (tx) => tx.select().from(changeSets).where(eq(changeSets.id, out.changeSetId)));
    expect(cs!.kind).toBe("restructure");
    const made = await as("wade", (tx, c) => listRows(tx, c, customersId, "customers"));
    expect(made.map((r) => r.data.name)).toEqual(["Northwind", "Kova"]);
    expect(made.find((r) => r.data.name === "Northwind")!.data.yearly_value).toBe(3_840_000);
    const linkId = (await as("wade", (tx) => getFile(tx, contractsId)))!.file.sheets[0]!.titleColumn;
    const now = await as("wade", (tx, c) => listRows(tx, c, contractsId, "contracts"));
    expect(now.map((r) => r.data.customer)).toEqual(typed); // kept as typed
    expect(now.map((r) => made.find((m) => m.id === r.data[linkId])?.data.name)).toEqual(typed);
    const events = await as("wade", (tx) => tx.select().from(auditEntries).where(eq(auditEntries.changeSetId, out.changeSetId)).orderBy(asc(auditEntries.seq)));
    expect(events.map((e) => e.event)).toEqual(["capability.created", "changeset.applied", "changeset.moved"]);
    expect(events[2]!.details).toEqual({ sheet: "Contracts", change: "Customer, as typed → Customer, linked to Customers", linked: 2, added: 2 });
  });

  it("saves nothing when an app it adds to changed after the plan was made", async () => {
    const spendId = (await capNamed("Spend"))!;
    const newId = crypto.randomUUID();
    const note = { ...alsoChanges[0]!, change: "Add a Bill note column", edits: [{ ...alsoChanges[0]!.edits[0]!, column: col("Bill note", "text") }] };
    const plan = await checked({ capability: { ...bills, name: "Bills two" }, rules: [], alsoChanges: [note] }, newId);
    expect(plan.problems).toEqual([]);
    const now = (await as("wade", (tx) => getFile(tx, spendId)))!;
    await as("wade", (tx, c) => saveVersion(tx, c, spendId, { ...now.file, description: "Changed meanwhile" }, { source: "customize", event: "customize.saved" }));
    await expect(as("wade", (tx, c) => applyPlan(tx, c, { plan, newId, chatId: crypto.randomUUID(), changes: new Map() }))).rejects.toThrow(
      "Spend has changed since this plan was made. Reply to make the plan again.",
    );
    expect(await capNamed("Bills two")).toBeUndefined();
  });

  it("refuses a plan that still has problems, and admins only", async () => {
    const plan = await checked({ capability: { ...contracts, name: "Spend" }, rules: [], alsoChanges: [] }, crypto.randomUUID());
    await expect(as("wade", (tx, c) => applyPlan(tx, c, { plan, newId: crypto.randomUUID(), chatId: crypto.randomUUID(), changes: new Map() }))).rejects.toThrow(
      "There is already an app called Spend.",
    );
    const ok = await checked({ capability: { ...contracts, name: "Maya's contracts" }, rules: [], alsoChanges: [] }, crypto.randomUUID());
    await expect(as("maya", (tx, c) => applyPlan(tx, c, { plan: ok, newId: crypto.randomUUID(), chatId: crypto.randomUUID(), changes: new Map() }))).rejects.toThrow("Only admins can do that.");
  });
});
