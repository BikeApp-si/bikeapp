// Seeds Fernwood Labs, Fernwood before Step 5 and Acme through the kernel. Safe to run again: a workspace that exists is left as it is.
// Usage: pnpm db:seed [--test]
import { closeDb } from "@/db/client";
import { createWorkspace, workspaceBySubdomain, type NewWorkspace } from "@/server/kernel/workspaces";
import { importPeople, type PersonInput } from "@/server/kernel/people";
import { addAdmin } from "@/server/kernel/settings";
import { withWorkspace } from "@/server/kernel/tx";
import { eq, inArray } from "drizzle-orm";
import { capabilities, people, workspaces } from "@/db/schema";
import { getFile, saveVersion } from "@/server/kernel/capabilities";
import { ACME, ACME_ADMIN, ACME_PEOPLE } from "./acme";
import { FERNWOOD, FERNWOOD_ADMIN, FERNWOOD_NEW, FERNWOOD_PACK, FERNWOOD_PEOPLE, FERNWOOD_TIMES } from "./fernwood";
import { seedCapabilities } from "./capabilities";
import { seedHistory } from "./history";
export { seedOntologyVersions } from "./ontology-versions";
export { seedSchool } from "./school";
export { seedServicesFirm } from "./services-firm";
import { TODAY } from "./capabilities/seeder";

// times: when the workspace was created and its team imported (Fernwood's come before its first capability).
export async function seedWorkspace(
  ws: Omit<NewWorkspace, "admin">,
  admin: NewWorkspace["admin"],
  rows: PersonInput[],
  times: { created?: string; imported?: string } = {},
) {
  const existing = await workspaceBySubdomain(ws.subdomain);
  if (existing) return { workspaceId: existing.id, created: false };
  const created = await createWorkspace({ ...ws, admin, setupDone: true, paid: true, at: times.created ? new Date(times.created) : undefined });
  await withWorkspace(created, (tx) => importPeople(tx, created, admin.email, rows, "seed", times.imported ? new Date(times.imported) : undefined));
  return { workspaceId: created.workspaceId, created: true };
}

// Lena is an admin as well (9b, 8h), added by Wade.
async function seedFernwoodAdmins(workspaceId: string) {
  await withWorkspace({ workspaceId }, async (tx) => {
    const [wade, lena] = await Promise.all(["wade", "lena"].map((n) => tx.select({ id: people.id }).from(people).where(eq(people.email, `${n}@fernwood.dev`)).then((r) => r[0]!.id)));
    await addAdmin(tx, { workspaceId, actor: { id: wade!, email: "wade@fernwood.dev" }, now: new Date(FERNWOOD_TIMES.lenaAdmin) }, lena!);
  });
}

// Another full Fernwood at its own address, for a Playwright flow that changes how capabilities work (Step 6),
// so the flows that read Fernwood as the screens show it are untouched.
export async function seedFernwoodCopy(subdomain: string) {
  const copy = await seedWorkspace({ ...FERNWOOD, subdomain }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES);
  if (copy.created) await seedFernwoodAdmins(copy.workspaceId);
  await seedCapabilities(copy.workspaceId);
  return copy;
}

// G2: Fernwood's people and admins with no apps yet, for adding an app set to an empty company.
export async function seedFernwoodTeam(subdomain: string) {
  const copy = await seedWorkspace({ ...FERNWOOD, subdomain }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES);
  if (copy.created) await seedFernwoodAdmins(copy.workspaceId);
  return copy;
}

// 0.5 (M26) on a copy: Fernwood as a company in India writes rupees, 12,34,567, "14 Nov 2026", and its year runs
// April to March. Its report history too, so a report reads in rupees. The amounts are Fernwood's, not converted.
export async function seedFernwoodIndia(subdomain: string) {
  const copy = await seedFernwoodCopy(subdomain);
  if (!copy.created) return copy;
  await seedHistory(copy.workspaceId);
  await withWorkspace({ workspaceId: copy.workspaceId }, (tx) =>
    tx
      .update(workspaces)
      .set({ country: "IN", city: "Bengaluru", addressRegion: "KA", currency: "INR", holidayCountry: "IN", numberGrouping: "indian", dateStyle: "dmy", fiscalYearStart: 4 })
      .where(eq(workspaces.id, copy.workspaceId)),
  );
  return copy;
}

// 0.3 (M17) on a copy: "Ask for a receipt only when the amount is over $75", saved as a new version of Spend as
// Customize would, with the rule change it needs: an expense under $75 is Submitted when added, since it can't wait
// for a receipt it isn't asked for.
export async function seedReceiptOver75(subdomain: string) {
  const ws = await workspaceBySubdomain(subdomain);
  if (!ws) return;
  await withWorkspace({ workspaceId: ws.id }, async (tx) => {
    const [spend] = await tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, "Spend"));
    const [wade] = await tx.select({ id: people.id }).from(people).where(eq(people.email, "wade@fernwood.dev"));
    const file = structuredClone((await getFile(tx, spend!.id))!.file);
    const expenses = file.sheets.find((x) => x.id === "expenses")!;
    if (expenses.columns.some((c) => c.showWhen)) return;
    expenses.columns.find((c) => c.id === "receipt")!.showWhen = { op: "gt", args: [{ col: "amount" }, 7500] };
    const rule = file.rules.find((r) => r.id === "added_with_receipt")!;
    rule.text = "An expense added with its receipt, or under $75, is Submitted.";
    rule.reading = { when: "An expense is added with its receipt, or under $75", then: "It moves to Submitted" };
    rule.condition = {
      op: "and",
      args: [
        { op: "eq", args: [{ col: "status" }, "needs_receipt"] },
        { op: "or", args: [{ op: "not", args: [{ op: "empty", args: [{ col: "receipt" }] }] }, { op: "lte", args: [{ col: "amount" }, 7500] }] },
      ],
    };
    await saveVersion(tx, { workspaceId: ws.id, actor: { id: wade!.id, email: "wade@fernwood.dev" } }, spend!.id, file, {
      source: "customize",
      event: "customize.saved",
      details: { changes: "Receipt is asked for only over $75" },
    });
  });
}

// 0.3 (M17b) on a copy: Customer contracts as before its tabs, so "Split the contract form into Basics, Dates and
// Documents" in Customize does what it says.
export async function seedWithoutContractForm(subdomain: string) {
  const ws = await workspaceBySubdomain(subdomain);
  if (!ws) return;
  await withWorkspace({ workspaceId: ws.id }, async (tx) => {
    const [cap] = await tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, "Customer contracts"));
    const [wade] = await tx.select({ id: people.id }).from(people).where(eq(people.email, "wade@fernwood.dev"));
    const file = structuredClone((await getFile(tx, cap!.id))!.file);
    const contracts = file.sheets.find((x) => x.id === "contracts")!;
    if (!contracts.form) return;
    delete contracts.form;
    await saveVersion(tx, { workspaceId: ws.id, actor: { id: wade!.id, email: "wade@fernwood.dev" } }, cap!.id, file, { source: "customize", event: "customize.saved", details: { changes: "The contract form as one list" } });
  });
}

export async function seed() {
  const fernwood = await seedWorkspace(FERNWOOD, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES);
  if (fernwood.created) await seedFernwoodAdmins(fernwood.workspaceId);
  const capabilitiesSeeded = await seedCapabilities(fernwood.workspaceId);
  // The report history (M8), in its own part, only with the capabilities it adds up.
  if (capabilitiesSeeded) await seedHistory(fernwood.workspaceId);
  const fernwoodNew = await seedWorkspace(FERNWOOD_NEW, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES);
  if (fernwoodNew.created) await seedFernwoodAdmins(fernwoodNew.workspaceId);
  await seedCapabilities(fernwoodNew.workspaceId, { contracts: false });
  await seedWorkspace(FERNWOOD_PACK, FERNWOOD_ADMIN, []);
  const acme = await seedWorkspace(ACME, ACME_ADMIN, ACME_PEOPLE);
  return { fernwood: { ...fernwood, capabilitiesSeeded }, fernwoodNew, acme };
}

// The open Bike serves one company (BIKE_MODE=single): Fernwood alone, as seed() makes it.
export async function seedFernwoodOnly() {
  const fernwood = await seedWorkspace(FERNWOOD, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES);
  if (fernwood.created) await seedFernwoodAdmins(fernwood.workspaceId);
  const capabilitiesSeeded = await seedCapabilities(fernwood.workspaceId);
  if (capabilitiesSeeded) await seedHistory(fernwood.workspaceId);
  return { fernwood: { ...fernwood, capabilitiesSeeded } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.loadEnvFile(); } catch {}
  if (process.argv.includes("--test")) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BIKE_TODAY ??= TODAY;
  const result = await seed();
  const said = (done: boolean) => (done ? "seeded" : "already there");
  console.log(`Fernwood ${said(result.fernwood.created)} (capabilities ${said(result.fernwood.capabilitiesSeeded)}), Fernwood before Step 5 ${said(result.fernwoodNew.created)}, Acme ${said(result.acme.created)}`);
  await closeDb();
}

// 0.4 (M24) on a copy: these capabilities count as just created, so their tutorial cards show.
export async function seedNewCapabilities(subdomain: string, names: string[]) {
  const ws = await workspaceBySubdomain(subdomain);
  if (!ws) return;
  await withWorkspace({ workspaceId: ws.id }, (tx) => tx.update(capabilities).set({ introduce: true }).where(inArray(capabilities.name, names)));
}

// C1 on a copy: Sales leads as the pilot had it (Lead owners see their own leads, Wade and Dev every lead), with a
// lead each for Rita and Leo, so adding a Companies sheet through Customize can be followed into the Data tab.
export async function seedSalesLeads(subdomain: string) {
  const ws = await workspaceBySubdomain(subdomain);
  if (!ws) return;
  const { salesLeadsFile } = await import("@/server/kernel/fixtures");
  const { createCapability } = await import("@/server/kernel/capabilities");
  const { createRow } = await import("@/server/kernel/rows");
  const id = (tx: Parameters<Parameters<typeof withWorkspace>[1]>[0], n: string) => tx.select({ id: people.id }).from(people).where(eq(people.email, `${n}@fernwood.dev`)).then((r) => r[0]!.id);
  await withWorkspace({ workspaceId: ws.id }, async (tx) => {
    if ((await tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, "Sales leads"))).length) return;
    const wade = await id(tx, "wade");
    const ctx = { workspaceId: ws.id, actor: { id: wade, email: "wade@fernwood.dev" }, now: new Date(`${TODAY}T15:00:00Z`) };
    const { id: cap } = await createCapability(tx, ctx, salesLeadsFile([wade, await id(tx, "dev")]), { source: "build" });
    for (const [who, company] of [["rita", "Northwind"], ["leo", "Kova"]] as const) await createRow(tx, ctx, cap, "leads", { values: { company, owner: await id(tx, who) } });
  });
}

// M27 on a copy: a Customers list with every customer typed on Fernwood's contracts but Quill Media, so turning
// Customer into a link is refused for that one contract until Quill Media is added.
export async function seedCustomers(subdomain: string) {
  const ws = await workspaceBySubdomain(subdomain);
  if (!ws) return;
  const { createCapability } = await import("@/server/kernel/capabilities");
  const { createRow } = await import("@/server/kernel/rows");
  await withWorkspace({ workspaceId: ws.id }, async (tx) => {
    if ((await tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, "Customers"))).length) return;
    const [wade] = await tx.select({ id: people.id }).from(people).where(eq(people.email, "wade@fernwood.dev"));
    const ctx = { workspaceId: ws.id, actor: { id: wade!.id, email: "wade@fernwood.dev" }, now: new Date(`${TODAY}T15:00:00Z`) };
    const { id: cap } = await createCapability(
      tx,
      ctx,
      {
        name: "Customers",
        icon: "building-2",
        sheets: [{ id: "customers", name: "Customers", kind: "list", row: { one: "customer", many: "customers" }, addAction: "New customer", titleColumn: "name", columns: [{ id: "name", name: "Name", type: "text", required: true }, { id: "website", name: "Website", type: "url" }] }],
        roles: [{ id: "managers", name: "Customer managers", members: { kind: "people", people: [wade!.id] }, can: ["see", "add", "edit", "delete", "customize"], scope: "all" }],
        rules: [],
        later: [],
      },
      { source: "build" },
    );
    for (const name of ["Northwind", "Acme Health", "Pinecone Labs", "Orbit Health", "Brightline", "Kova", "Lumen Retail", "Harbor Logistics", "Sable Analytics", "Fieldstone", "Cedar Freight"])
      await createRow(tx, ctx, cap, "customers", { values: { name } });
  });
}

// M25 on a copy: Admissions, a capability at every limit (6 sheets of 40 questions, 20 rules), with three
// applications, each with every question answered that a test reads.
export async function seedBigCapability(subdomain: string) {
  const ws = await workspaceBySubdomain(subdomain);
  if (!ws) return;
  const { bigFile } = await import("@/server/kernel/fixtures");
  const { createCapability } = await import("@/server/kernel/capabilities");
  const { createRow } = await import("@/server/kernel/rows");
  await withWorkspace({ workspaceId: ws.id }, async (tx) => {
    if ((await tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, "Admissions"))).length) return;
    const [wade] = await tx.select({ id: people.id }).from(people).where(eq(people.email, "wade@fernwood.dev"));
    const ctx = { workspaceId: ws.id, actor: { id: wade!.id, email: "wade@fernwood.dev" }, now: new Date(`${TODAY}T15:00:00Z`) };
    const { id: cap } = await createCapability(tx, ctx, bigFile([wade!.id]), { source: "build" });
    for (const [n, student] of ["Aarav Shah", "Diya Menon", "Kabir Rao"].entries())
      await createRow(tx, ctx, cap, "applications", { values: { student, grade: `g${n + 1}`, fee: 1_500_000, q12: `Answer ${n}`, q36: `Last answer ${n}` } });
  });
}

// C3 on a copy: Income and expenses as on Wade's screenshot of Nov 3, with six entries (two without a category, none
// with a receipt), so the advice has counts to read.
export async function seedIncomeExpenses(subdomain: string) {
  const ws = await workspaceBySubdomain(subdomain);
  if (!ws) return;
  const { addIncomeExpenses } = await import("@/tests/customize-c3");
  await withWorkspace({ workspaceId: ws.id }, async (tx) => {
    if ((await tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, "Income and expenses"))).length) return;
    const [wade] = await tx.select({ id: people.id }).from(people).where(eq(people.email, "wade@fernwood.dev"));
    await addIncomeExpenses(tx, { workspaceId: ws.id, actor: { id: wade!.id, email: "wade@fernwood.dev" }, now: new Date(`${TODAY}T15:00:00Z`) });
  });
}

// M28 on a copy: Spend with cost centres that sit under each other (m28-a), and Fernwood's expenses on them, so the
// tree, its folds and Total spent can be followed in the Data tab without the AI.
export async function seedCostCentres(subdomain: string) {
  const ws = await workspaceBySubdomain(subdomain);
  if (!ws) return;
  const { createRow, listRows, updateRow } = await import("@/server/kernel/rows");
  const { costCentresVersion } = await import("@/server/kernel/fixtures");
  await withWorkspace({ workspaceId: ws.id }, async (tx) => {
    const [cap] = await tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, "Spend"));
    const file = (await getFile(tx, cap!.id))!.file;
    if (file.sheets.some((s) => s.id === "centres")) return;
    const p = (n: string) => tx.select({ id: people.id }).from(people).where(eq(people.email, `${n}@fernwood.dev`)).then((r) => r[0]!.id);
    const wade = await p("wade");
    const ctx = { workspaceId: ws.id, actor: { id: wade, email: "wade@fernwood.dev" }, now: new Date(`${TODAY}T15:00:00Z`) };
    await saveVersion(tx, ctx, cap!.id, costCentresVersion(file), { source: "customize", event: "customize.saved", details: { changes: "Cost centres" } });
    const add = async (name: string, owner: string, under?: string) =>
      (await createRow(tx, ctx, cap!.id, "centres", { values: { name, owner: await p(owner), ...(under ? { under } : {}) } })).id;
    const top = await add("Fernwood Labs", "wade");
    const eng = await add("Engineering", "priya", top);
    const platform = await add("Platform", "kim", eng);
    const cloud = await add("Cloud hosting", "kim", platform);
    const web = await add("Web", "omar", eng);
    const growth = await add("Growth", "dev", top);
    const ops = await add("Operations", "krishna", top);
    const office = await add("Office", "jon", ops);
    const on: Record<string, string> = {
      "Domain renewal": top,
      "Conference ticket": eng,
      "AWS, September": cloud,
      "Datadog, extra hosts": cloud,
      "Figma, annual seat": web,
      "Notion, team plan": web,
      "Canva Pro": growth,
      "Client dinner, Kova": growth,
      "Train to Dallas": growth,
      "Uber, Oct 3": growth,
      "Lyft, Aug 27": growth,
      "Parking, Austin": growth,
      "Amazon order 114-2290": ops,
      "Coffee for interviews": ops,
      Postage: ops,
      "HDMI adapters": ops,
      "Office plants": office,
    };
    for (const e of await listRows(tx, ctx, cap!.id, "expenses")) {
      const centre = on[String(e.data.what)];
      if (centre) await updateRow(tx, ctx, e.id, { centre });
    }
  });
}

// M30 on a copy: Spend with its spending limits, as Customize leaves it (m30-a to m30-c), so the limits, the check and
// the refusals can be followed without the AI. Meals is $75 until Oct 31 and $90 from Nov 1, still to come on the
// seed's today.
// M32: the office rent repeating in Spend, saved on Sep 15, and the daily job run on the seed's today, so it has
// caught up the rent of Oct 1 (m32-b).
export async function seedOfficeRent(subdomain: string) {
  const ws = await workspaceBySubdomain(subdomain);
  if (!ws) return;
  const { repeatsVersion } = await import("@/server/kernel/fixtures");
  const { runRepeats } = await import("@/server/kernel/repeats");
  const { systemCtx } = await import("@/server/kernel/date-rules");
  await withWorkspace({ workspaceId: ws.id }, async (tx) => {
    const [cap] = await tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, "Spend"));
    const file = (await getFile(tx, cap!.id))!.file;
    if (file.rules.some((r) => r.id === "office_rent")) return;
    const [wade] = await tx.select({ id: people.id }).from(people).where(eq(people.email, "wade@fernwood.dev"));
    const ctx = { workspaceId: ws.id, actor: { id: wade!.id, email: "wade@fernwood.dev" }, now: new Date("2026-09-15T15:00:00Z") };
    await saveVersion(tx, ctx, cap!.id, repeatsVersion(file, wade!.id), { source: "customize", event: "customize.saved", details: { changes: "Office rent" } });
    await runRepeats(tx, systemCtx(ws.id, new Date(`${TODAY}T15:00:00Z`)));
  });
}

export async function seedSpendingLimits(subdomain: string) {
  const ws = await workspaceBySubdomain(subdomain);
  if (!ws) return;
  const { createRow } = await import("@/server/kernel/rows");
  const { spendingLimitsVersion } = await import("@/server/kernel/fixtures");
  await withWorkspace({ workspaceId: ws.id }, async (tx) => {
    const [cap] = await tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, "Spend"));
    const file = (await getFile(tx, cap!.id))!.file;
    if (file.sheets.some((s) => s.id === "limits")) return;
    const [wade] = await tx.select({ id: people.id }).from(people).where(eq(people.email, "wade@fernwood.dev"));
    const ctx = { workspaceId: ws.id, actor: { id: wade!.id, email: "wade@fernwood.dev" }, now: new Date(`${TODAY}T15:00:00Z`) };
    await saveVersion(tx, ctx, cap!.id, spendingLimitsVersion(file), { source: "customize", event: "customize.saved", details: { changes: "Spending limits" } });
    const limits: [string, string, number][] = [
      ["meals", "2025-01-01", 6000],
      ["meals", "2026-01-01", 7500],
      ["meals", "2026-11-01", 9000],
      ["travel", "2026-01-01", 50000],
      ["software", "2026-01-01", 20000],
      ["software", "2026-07-01", 30000],
      ["cloud", "2026-01-01", 200000],
      ["office", "2026-01-01", 25000],
    ];
    for (const [category, from, limit] of limits) await createRow(tx, ctx, cap!.id, "limits", { values: { category, from, limit } });
  });
}

// M29 on a copy: Time off with its leave ledger, as Customize leaves it (m29-a, m29-b), with two entries from
// approved requests, so the ledger, Reverse and its refusals can be followed without the AI. Maya's balance is left
// as it is (12 days left) for the approval the tests make.
export async function seedLeaveLedger(subdomain: string) {
  const ws = await workspaceBySubdomain(subdomain);
  if (!ws) return;
  const { createRow } = await import("@/server/kernel/rows");
  const { fillNewComputed } = await import("@/server/kernel/changesets");
  const { leaveLedgerVersion } = await import("@/server/kernel/fixtures");
  await withWorkspace({ workspaceId: ws.id }, async (tx) => {
    const [cap] = await tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, "Time off"));
    const before = (await getFile(tx, cap!.id))!.file;
    if (before.sheets.some((s) => s.id === "leave")) return;
    const p = (n: string) => tx.select({ id: people.id }).from(people).where(eq(people.email, `${n}@fernwood.dev`)).then((r) => r[0]!.id);
    const ctx = { workspaceId: ws.id, actor: { id: await p("wade"), email: "wade@fernwood.dev" }, now: new Date(`${TODAY}T15:00:00Z`) };
    const after = leaveLedgerVersion(before);
    await saveVersion(tx, ctx, cap!.id, after, { source: "customize", event: "customize.saved", details: { changes: "Leave entries" } });
    await fillNewComputed(tx, ctx, cap!.id, before, after);
    await createRow(tx, ctx, cap!.id, "leave", { values: { entry: "Personal, Oct 9–10", who: await p("omar"), days: -2, added: "2026-10-08" } });
    await createRow(tx, ctx, cap!.id, "leave", { values: { entry: "Sick, Oct 20", who: await p("kim"), days: -1, added: "2026-10-20" } });
  });
}

// M29 on a copy: Stock, office equipment kept as a ledger of moves in and out (m29-c), with Laptops at 2.
export async function seedStock(subdomain: string) {
  const ws = await workspaceBySubdomain(subdomain);
  if (!ws) return;
  const { stockFile } = await import("@/server/kernel/fixtures");
  const { createCapability } = await import("@/server/kernel/capabilities");
  const { createRow } = await import("@/server/kernel/rows");
  await withWorkspace({ workspaceId: ws.id }, async (tx) => {
    if ((await tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, "Stock"))).length) return;
    const p = (n: string) => tx.select({ id: people.id }).from(people).where(eq(people.email, `${n}@fernwood.dev`)).then((r) => r[0]!.id);
    const [wade, jon] = [await p("wade"), await p("jon")];
    const ctx = { workspaceId: ws.id, actor: { id: jon, email: "jon@fernwood.dev" }, now: new Date(`${TODAY}T15:00:00Z`) };
    const { id: cap } = await createCapability(tx, { ...ctx, actor: { id: wade, email: "wade@fernwood.dev" } }, stockFile([wade, jon]), { source: "build" });
    const item = async (name: string) => (await createRow(tx, ctx, cap, "items", { values: { name } })).id;
    const [laptops, monitors] = [await item("Laptops"), await item("Monitors")];
    await item("Chairs");
    const move = (move: string, it: string, quantity: number, date: string) => createRow(tx, ctx, cap, "moves", { values: { move, item: it, quantity, date } });
    await move("Bought from the supplier", laptops, 5, "2026-10-02");
    await move("Bought from the supplier", monitors, 8, "2026-10-02");
    await move("Given to new starters", laptops, -3, "2026-10-14");
    await move("Given to new starters", monitors, -2, "2026-10-14");
  });
}
