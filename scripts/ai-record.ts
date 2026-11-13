// Records real AI answers for Step 5, setup, Step 6 (Customize) and Step 4 (a build from the synthetic pack), once each, into server/ai/fixtures/, so tests replay them. It runs the
// whole sequence the Playwright flow runs (tests/e2e/step5.spec.ts), in the same order, because each request
// carries the capabilities that exist at that point: Customer contracts (5a–5f), its file and Create (5g–5h),
// Supplier bills and Create (5j), then Customers (5l). Answers already recorded are replayed, so only new
// requests reach the API. It works in a fresh workspace in the test database, never in your dev data.
// Usage: pnpm ai:record
import { runQueued } from "@/server/jobs/run";
import "@/server/jobs/runners";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";

try { process.loadEnvFile(); } catch {}
process.env.AI_PROVIDER = "record";
process.env.AI_CREDITS_UNLIMITED = "1"; // a recording run builds many companies in one; never in production
process.env.SCAN_PROVIDER ??= "memory"; // its own test files, in the test database
process.env.BIKE_TODAY ??= "2026-10-27"; // the seed's today, as Vitest and Playwright run it
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { closeDb } = await import("@/db/client");
const { aiCalls, people } = await import("@/db/schema");
const { seedWorkspace } = await import("@/seed");
const { seedCapabilities } = await import("@/seed/capabilities");
const { FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES } = await import("@/seed/fernwood");
const { send, create } = await import("@/server/chat/send");
const { readChat } = await import("@/server/kernel/chats");
const { saveUpload } = await import("@/server/kernel/uploads");
const { withWorkspace } = await import("@/server/kernel/tx");
const { STEP5 } = await import("@/tests/step5");
const { usedFixtures } = await import("@/server/ai/providers/fixtures");
type Ctx = import("@/server/kernel/context").KernelCtx;
type Tx = import("@/server/kernel/tx").Tx;

const ws = (await seedWorkspace({ subdomain: `rec${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
await seedCapabilities(ws, { contracts: false });
const [wade] = await withWorkspace({ workspaceId: ws }, (tx) => tx.select({ id: people.id, email: people.email }).from(people).where(sql`${people.email} = 'wade@fernwood.dev'`));
const ctx: Ctx = { workspaceId: ws, actor: { id: wade!.id, email: wade!.email } };
const k = <T>(fn: (tx: Tx, c: Ctx) => Promise<T>) => withWorkspace({ workspaceId: ws, personId: wade!.id }, (tx) => fn(tx, ctx));

// A message (with files), as Home sends it, and the reply once its work is done.
async function say(chatId: string | null, text: string, files: string[] = []) {
  const uploadIds: string[] = [];
  for (const path of files) uploadIds.push((await k((tx, c) => saveUpload(tx, c, { name: path.split("/").pop()!, body: readFileSync(path) }))).id);
  const out = await k((tx, c) => send(tx, c, chatId, text, uploadIds));
  await runQueued(ws);
  const last = (await k((tx, c) => readChat(tx, c, out.chatId))).messages.at(-1)!;
  console.log(`→ ${last.status}: ${last.text || JSON.stringify(last.parts)}`);
  if (last.status !== "done") throw new Error("That step didn't finish; nothing after it was recorded.");
  return { chatId: out.chatId, last };
}

async function createPlan(chatId: string, planId: string, label: string, withImport: boolean) {
  await k((tx, c) => create(tx, c, chatId, planId, label, { withImport, withoutRestructure: false }));
  await runQueued(ws);
  const last = (await k((tx, c) => readChat(tx, c, chatId))).messages.at(-1)!;
  console.log(`→ ${last.status}: ${last.text}`);
  if (last.status !== "done") throw new Error("Create didn't finish.");
}
const planOf = (m: { parts: { kind: string; planId?: string }[] }) => m.parts.find((p) => p.planId)!.planId!;

// Chat A (5a–5f): the plan, then a reply with the contract policy.
const a = await say(null, STEP5.contracts);
await say(a.chatId, STEP5.tweak, ["tests/files/Fernwood-contract-policy.pdf"]);
// Chat B (5a, 5g, 5h): the plan, the file, Create.
const b = await say(null, STEP5.contracts);
const imported = await say(b.chatId, STEP5.importNote, ["tests/files/contracts.csv"]);
await createPlan(b.chatId, planOf(imported.last), "Create and import 12 contracts", true);
// Chat C (5j): Supplier bills with the purchasing policy, and Create with its changes.
const c = await say(null, STEP5.bills, ["tests/files/Purchasing policy.pdf"]);
await createPlan(c.chatId, planOf(c.last), "Create Supplier bills and the changes", false);
// Chat D (5l): a change that needs a data move.
await say(null, STEP5.customers);

// M28: a capability whose rows sit under each other, from Home's chat, on a Fernwood without Customer contracts as
// server/chat/tree.replay.test.ts has it.
const { TREES } = await import("@/tests/trees");
const ft = (await seedWorkspace({ subdomain: `rec28${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
await seedCapabilities(ft, { contracts: false });
{
  const [u] = await withWorkspace({ workspaceId: ft }, (tx) => tx.select({ id: people.id, email: people.email }).from(people).where(sql`${people.email} = 'wade@fernwood.dev'`));
  const kt = <T>(fn: (tx: Tx, c: Ctx) => Promise<T>) => withWorkspace({ workspaceId: ft, personId: u!.id }, (tx) => fn(tx, { workspaceId: ft, actor: { id: u!.id, email: u!.email } }));
  const out = await kt((tx, c) => send(tx, c, null, TREES.build, []));
  await runQueued(ft);
  const last = (await kt((tx, c) => readChat(tx, c, out.chatId))).messages.at(-1)!;
  console.log(`→ M28 tree ${last.status}: ${last.text || JSON.stringify(last.parts)}`);
  if (last.status !== "done") throw new Error("The tree plan didn't finish; nothing after it was recorded.");
}

// M29: a capability kept as a ledger (stock moves that can't go below zero), from Home's chat, as
// server/chat/ledger.replay.test.ts has it.
const { LEDGERS } = await import("@/tests/ledgers");
const fl = (await seedWorkspace({ subdomain: `rec29${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
await seedCapabilities(fl, { contracts: false });
{
  const [u] = await withWorkspace({ workspaceId: fl }, (tx) => tx.select({ id: people.id, email: people.email }).from(people).where(sql`${people.email} = 'wade@fernwood.dev'`));
  const kl = <T>(fn: (tx: Tx, c: Ctx) => Promise<T>) => withWorkspace({ workspaceId: fl, personId: u!.id }, (tx) => fn(tx, { workspaceId: fl, actor: { id: u!.id, email: u!.email } }));
  const out = await kl((tx, c) => send(tx, c, null, LEDGERS.build, []));
  await runQueued(fl);
  const last = (await kl((tx, c) => readChat(tx, c, out.chatId))).messages.at(-1)!;
  console.log(`→ M29 ledger ${last.status}: ${last.text || JSON.stringify(last.parts)}`);
  if (last.status !== "done") throw new Error("The ledger plan didn't finish; nothing after it was recorded.");
}

// M30: a price list kept by date, with quotes reading the price in force on their date, from Home's chat, as
// server/chat/dated.replay.test.ts has it.
const { DATED } = await import("@/tests/dated");
const fd = (await seedWorkspace({ subdomain: `rec30${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
await seedCapabilities(fd, { contracts: false });
{
  const [u] = await withWorkspace({ workspaceId: fd }, (tx) => tx.select({ id: people.id, email: people.email }).from(people).where(sql`${people.email} = 'wade@fernwood.dev'`));
  const kd = <T>(fn: (tx: Tx, c: Ctx) => Promise<T>) => withWorkspace({ workspaceId: fd, personId: u!.id }, (tx) => fn(tx, { workspaceId: fd, actor: { id: u!.id, email: u!.email } }));
  const out = await kd((tx, c) => send(tx, c, null, DATED.build, []));
  await runQueued(fd);
  const last = (await kd((tx, c) => readChat(tx, c, out.chatId))).messages.at(-1)!;
  console.log(`→ M30 price list ${last.status}: ${last.text || JSON.stringify(last.parts)}`);
  if (last.status !== "done") throw new Error("The price list plan didn't finish; nothing after it was recorded.");
}

// Setup (2b–2e), prompt 8 and the team file's mapping, each in a new workspace as sign up makes it.
const { SETUP, newFernwood } = await import("@/tests/setup");
const flow = await import("@/server/setup/flow");
const { readSetup } = await import("@/server/kernel/setup/state");
async function lastSetupReply(w: Awaited<ReturnType<typeof newFernwood>>) {
  const m = (await w.k((tx, c) => readSetup(tx, c))).state.messages.at(-1)!;
  console.log(`→ setup: ${JSON.stringify(m).slice(0, 300)}`);
  if (m.from !== "bike" || m.status !== "done") throw new Error("That setup step didn't finish; nothing after it was recorded.");
}
const s1 = await newFernwood();
await s1.say((tx, c) => flow.sendOrganization(tx, c, SETUP.organization, []));
await lastSetupReply(s1);
await s1.k((tx, c) => flow.continueToTeam(tx, c));
const xlsx = await s1.upload("tests/files/team.xlsx");
await s1.say((tx, c) => flow.sendTeam(tx, c, SETUP.team, [xlsx]));
await lastSetupReply(s1);
await s1.say((tx, c) => flow.sendTeam(tx, c, SETUP.correction, []));
await lastSetupReply(s1);
const s2 = await newFernwood();
await s2.k((tx, c) => flow.skipOrganization(tx, c));
await s2.say((tx, c) => flow.sendTeam(tx, c, SETUP.typed, []));
await lastSetupReply(s2);
const s4 = await newFernwood();
await s4.k((tx, c) => flow.skipOrganization(tx, c));
await s4.say((tx, c) => flow.sendTeam(tx, c, SETUP.override, []));
await lastSetupReply(s4);
const s3 = await newFernwood();
await s3.k((tx, c) => flow.skipOrganization(tx, c));
const other = await s3.upload("tests/files/team-other-headers.csv");
await s3.say((tx, c) => flow.sendTeam(tx, c, "", [other]));
await lastSetupReply(s3);

// Customize (6b–6l), in the full Fernwood as the screens show it: Customer contracts' chat, then Hiring's.
const { STEP6 } = await import("@/tests/step6");
const custom = await import("@/server/chat/customize");
const { plansIn } = await import("@/server/kernel/chats");
const fw = (await seedWorkspace({ subdomain: `rec6${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
await seedCapabilities(fw);
const [wade6] = await withWorkspace({ workspaceId: fw }, (tx) => tx.select({ id: people.id, email: people.email }).from(people).where(sql`${people.email} = 'wade@fernwood.dev'`));
const ctx6: Ctx = { workspaceId: fw, actor: { id: wade6!.id, email: wade6!.email } };
const k6 = <T>(fn: (tx: Tx, c: Ctx) => Promise<T>) => withWorkspace({ workspaceId: fw, personId: wade6!.id }, (tx) => fn(tx, ctx6));
const capId6 = async (name: string) => (await k6((tx) => tx.execute<{ id: string }>(sql`select id from capabilities where name = ${name}`)))[0]!.id;
async function customize(capId: string, text: string) {
  const out = await k6((tx, c) => custom.sendCustomize(tx, c, capId, text));
  await out.work();
  const last = (await k6((tx, c) => readChat(tx, c, out.chatId))).messages.at(-1)!;
  console.log(`→ customize ${last.status}: ${last.text || JSON.stringify(last.parts)}`);
  if (last.status !== "done") throw new Error("That Customize step didn't finish; nothing after it was recorded.");
  return out.chatId;
}
async function applyWaiting(chatId: string) {
  const plan = (await k6((tx, c) => plansIn(tx, c, chatId))).findLast((p) => p.status === "waiting")!;
  const out = await k6((tx, c) => custom.applyFromChat(tx, c, chatId, plan.id));
  await out.work();
  const last = (await k6((tx, c) => readChat(tx, c, chatId))).messages.at(-1)!;
  console.log(`→ apply ${last.status}: ${JSON.stringify(last.parts.at(-1))}`);
  if (last.status !== "done") throw new Error("Apply didn't finish.");
}
const contracts6 = await capId6("Customer contracts");
const chat6 = await customize(contracts6, STEP6.legal);
await applyWaiting(chat6);
await customize(contracts6, STEP6.draftRule);
await applyWaiting(chat6);
await customize(contracts6, STEP6.vague);
await customize(contracts6, STEP6.leo);
const hiring6 = await capId6("Hiring");
const chatH = await customize(hiring6, STEP6.hired);
await applyWaiting(chatH);

// M32: rows that repeat, written in Customize on Spend and applied, in a Fernwood as Playwright's copies have it
// (seedFernwoodCopy), as server/chat/repeats.replay.test.ts and tests/e2e/repeats.spec.ts replay it.
const { REPEATS } = await import("@/tests/repeats");
const { seedFernwoodCopy: copy32 } = await import("@/seed");
const fr = (await copy32(`rec32${Date.now().toString(36)}`)).workspaceId;
{
  const [u] = await withWorkspace({ workspaceId: fr }, (tx) => tx.select({ id: people.id, email: people.email }).from(people).where(sql`${people.email} = 'wade@fernwood.dev'`));
  const kr = <T>(fn: (tx: Tx, c: Ctx) => Promise<T>) => withWorkspace({ workspaceId: fr, personId: u!.id }, (tx) => fn(tx, { workspaceId: fr, actor: { id: u!.id, email: u!.email } }));
  const spend = (await kr((tx) => tx.execute<{ id: string }>(sql`select id from capabilities where name = 'Spend'`)))[0]!.id;
  const out = await kr((tx, c) => custom.sendCustomize(tx, c, spend, REPEATS.customize));
  await out.work();
  const last = (await kr((tx, c) => readChat(tx, c, out.chatId))).messages.at(-1)!;
  console.log(`→ M32 repeats ${last.status}: ${last.text || JSON.stringify(last.parts)}`);
  if (last.status !== "done") throw new Error("The repeating rule didn't finish; nothing after it was recorded.");
  const plan = (await kr((tx, c) => plansIn(tx, c, out.chatId))).findLast((p) => p.status === "waiting");
  if (!plan) throw new Error("The repeating rule has nothing to apply.");
  const applied = await kr((tx, c) => custom.applyFromChat(tx, c, out.chatId, plan.id));
  await applied.work();
}

// C1: new sheets under roles that see their own rows, and refusals that help, in a Fernwood of its own with
// Sales leads added as the pilot had it (tests/customize-c1.ts). Previews only: nothing here is applied.
const { C1 } = await import("@/tests/customize-c1");
const { salesLeadsFile } = await import("@/server/kernel/fixtures");
const { createCapability } = await import("@/server/kernel/capabilities");
const c1 = (await seedWorkspace({ subdomain: `recc1${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
await seedCapabilities(c1);
const [wadeC1] = await withWorkspace({ workspaceId: c1 }, (tx) => tx.select({ id: people.id, email: people.email }).from(people).where(sql`${people.email} = 'wade@fernwood.dev'`));
const ctxC1: Ctx = { workspaceId: c1, actor: { id: wadeC1!.id, email: wadeC1!.email } };
const kC1 = <T>(fn: (tx: Tx, c: Ctx) => Promise<T>) => withWorkspace({ workspaceId: c1, personId: wadeC1!.id }, (tx) => fn(tx, ctxC1));
const [devC1] = await kC1((tx) => tx.select({ id: people.id }).from(people).where(sql`${people.email} = 'dev@fernwood.dev'`));
await kC1((tx, c) => createCapability(tx, c, salesLeadsFile([wadeC1!.id, devC1!.id]), { source: "build" }));
const { fillToSheetLimit } = await import("@/tests/at-limit");
await fillToSheetLimit(c1, "Hiring");
async function customizeC1(capName: string, text: string) {
  const capId = (await kC1((tx) => tx.execute<{ id: string }>(sql`select id from capabilities where name = ${capName}`)))[0]!.id;
  const out = await kC1((tx, c) => custom.sendCustomize(tx, c, capId, text));
  await out.work();
  const last = (await kC1((tx, c) => readChat(tx, c, out.chatId))).messages.at(-1)!;
  console.log(`→ C1 ${capName} ${last.status}: ${last.text || JSON.stringify(last.parts)}`);
  if (last.status !== "done") throw new Error("That C1 step didn't finish; nothing after it was recorded.");
}
for (const text of C1.salesLeads) await customizeC1("Sales leads", text);
await customizeC1("Onboarding", C1.onboarding);
await customizeC1("Hiring", C1.hiring);
await customizeC1("Hiring", C1.hiring);

// C2: Customize that explains, in a Fernwood of its own with Sales leads: a question (the guide), its first
// suggestion pressed (a preview), a sheet with no owner applied, then why, what Bike can't do, and a word or two.
const { C2 } = await import("@/tests/customize-c2");
const c2 = (await seedWorkspace({ subdomain: `recc2${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
await seedCapabilities(c2);
const [wadeC2] = await withWorkspace({ workspaceId: c2 }, (tx) => tx.select({ id: people.id, email: people.email }).from(people).where(sql`${people.email} = 'wade@fernwood.dev'`));
const ctxC2: Ctx = { workspaceId: c2, actor: { id: wadeC2!.id, email: wadeC2!.email } };
const kC2 = <T>(fn: (tx: Tx, c: Ctx) => Promise<T>) => withWorkspace({ workspaceId: c2, personId: wadeC2!.id }, (tx) => fn(tx, ctxC2));
const [devC2] = await kC2((tx) => tx.select({ id: people.id }).from(people).where(sql`${people.email} = 'dev@fernwood.dev'`));
const salesC2 = (await kC2((tx, c) => createCapability(tx, c, salesLeadsFile([wadeC2!.id, devC2!.id]), { source: "build" }))).id;
async function customizeC2(text: string, via: import("@/server/chat/customize").Via = "typed") {
  const out = await kC2((tx, c) => custom.sendCustomize(tx, c, salesC2, text, via));
  await out.work();
  const last = (await kC2((tx, c) => readChat(tx, c, out.chatId))).messages.at(-1)!;
  console.log(`→ C2 ${via} ${last.status}: ${last.text.slice(0, 200)} ${JSON.stringify(last.parts).slice(0, 300)}`);
  if (last.status !== "done") throw new Error("That C2 step didn't finish; nothing after it was recorded.");
  return { chatId: out.chatId, last };
}
const stepsC2 = await customizeC2(C2.steps);
const firstC2 = stepsC2.last.parts.flatMap((p) => (p.kind === "buttons" ? p.buttons : []))[0];
if (!firstC2) throw new Error("The guide offered no request to press.");
await customizeC2(firstC2.label, "plan");
const noOwnerC2 = await customizeC2(C2.noOwner);
{
  const plan = (await kC2((tx, c) => plansIn(tx, c, noOwnerC2.chatId))).findLast((p) => p.status === "waiting");
  if (!plan) throw new Error("No preview to apply.");
  const applied = await kC2((tx, c) => custom.applyFromChat(tx, c, noOwnerC2.chatId, plan.id));
  await applied.work();
}
await customizeC2(C2.why);
await customizeC2(C2.slack);
const unsureC2 = await customizeC2(C2.unsure);
if (unsureC2.last.text === custom.UNSURE) await customizeC2("Explain first", "explain_first");

// C3: Customize that advises, in a Fernwood of its own with Sales leads and Income and expenses (six entries). Each
// question in its capability's chat; Income and expenses' first button pressed (a preview, not applied).
const { C3, addIncomeExpenses } = await import("@/tests/customize-c3");
const c3 = (await seedWorkspace({ subdomain: `recc3${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
await seedCapabilities(c3);
const [wadeC3] = await withWorkspace({ workspaceId: c3 }, (tx) => tx.select({ id: people.id, email: people.email }).from(people).where(sql`${people.email} = 'wade@fernwood.dev'`));
const ctxC3: Ctx = { workspaceId: c3, actor: { id: wadeC3!.id, email: wadeC3!.email } };
const kC3 = <T>(fn: (tx: Tx, c: Ctx) => Promise<T>) => withWorkspace({ workspaceId: c3, personId: wadeC3!.id }, (tx) => fn(tx, ctxC3));
const [devC3] = await kC3((tx) => tx.select({ id: people.id }).from(people).where(sql`${people.email} = 'dev@fernwood.dev'`));
await kC3((tx, c) => createCapability(tx, c, salesLeadsFile([wadeC3!.id, devC3!.id]), { source: "build" }));
await kC3((tx, c) => addIncomeExpenses(tx, c));
await fillToSheetLimit(c3, "Hiring");
async function customizeC3(capName: string, text: string, via: import("@/server/chat/customize").Via = "typed") {
  const capId = (await kC3((tx) => tx.execute<{ id: string }>(sql`select id from capabilities where name = ${capName}`)))[0]!.id;
  const out = await kC3((tx, c) => custom.sendCustomize(tx, c, capId, text, via));
  await out.work();
  const last = (await kC3((tx, c) => readChat(tx, c, out.chatId))).messages.at(-1)!;
  console.log(`→ C3 ${capName} ${via} ${last.status}: ${last.text.slice(0, 160)} ${JSON.stringify(last.parts.map((p) => (p.kind === "buttons" ? p.buttons.map((b) => b.label) : p.kind)))}`);
  if (last.status !== "done") throw new Error("That C3 step didn't finish; nothing after it was recorded.");
  return last;
}
const incomeC3 = await customizeC3("Income and expenses", C3.income);
const firstC3 = incomeC3.parts.flatMap((p) => (p.kind === "buttons" ? p.buttons : []))[0];
if (!firstC3) throw new Error("The advice offered no change to press.");
await customizeC3("Income and expenses", firstC3.label, "plan");
await customizeC3("Sales leads", C3.sales);
await customizeC3("Hiring", C3.hiring);
await customizeC3("Onboarding", C3.onboarding);

// Company rules (0.2, M14), in the full Fernwood as Customize's: the policy, Apply; a change, Apply; a vague
// message (a question back); the removal, Apply. With the policy live, the Ontology and the coherence check are
// written once more, now that they read company rules.
const { COMPANY } = await import("@/tests/company");
const companyChat = await import("@/server/chat/company-rules");
const { queueOntology } = await import("@/server/ontology/write");
const cr = (await seedWorkspace({ subdomain: `rec14${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
await seedCapabilities(cr);
const [wade14] = await withWorkspace({ workspaceId: cr }, (tx) => tx.select({ id: people.id, email: people.email }).from(people).where(sql`${people.email} = 'wade@fernwood.dev'`));
const ctx14: Ctx = { workspaceId: cr, actor: { id: wade14!.id, email: wade14!.email } };
const k14 = <T>(fn: (tx: Tx, c: Ctx) => Promise<T>) => withWorkspace({ workspaceId: cr, personId: wade14!.id }, (tx) => fn(tx, ctx14));
async function companySay(text: string, apply: boolean) {
  const out = await k14((tx, c) => companyChat.sendCompanyRules(tx, c, text));
  await out.work();
  const last = (await k14((tx, c) => readChat(tx, c, out.chatId))).messages.at(-1)!;
  console.log(`→ company rules ${last.status}: ${last.text || JSON.stringify(last.parts)}`);
  if (last.status !== "done") throw new Error("That company rules step didn't finish; nothing after it was recorded.");
  if (!apply) return;
  const plan = (await k14((tx, c) => plansIn(tx, c, out.chatId))).findLast((p) => p.status === "waiting");
  if (!plan) throw new Error("No preview to apply.");
  const applied = await k14((tx, c) => companyChat.applyCompanyFromChat(tx, c, out.chatId, plan.id));
  await applied.work();
  const done = (await k14((tx, c) => readChat(tx, c, out.chatId))).messages.at(-1)!;
  console.log(`→ company apply ${done.status}: ${JSON.stringify(done.parts.at(-1))}`);
  if (done.status !== "done") throw new Error("Company rules Apply didn't finish.");
}
await companySay(COMPANY.policy, true);
await k14((tx, c) => queueOntology(tx, c));
await runQueued(cr);
await companySay(COMPANY.change, true);
await companySay(COMPANY.vague, false);
await companySay(COMPANY.remove, true);

// Step 4 (4a–4d): the synthetic pack in one message on a Fernwood with only its founder, the plan, Build all,
// and the one question answered with its first choice.
const { STEP4 } = await import("@/tests/step4");
const build = await import("@/server/chat/build");
const b4 = (await seedWorkspace({ subdomain: `rec4${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, [])).workspaceId;
const [wade4] = await withWorkspace({ workspaceId: b4 }, (tx) => tx.select({ id: people.id, email: people.email }).from(people));
const ctx4: Ctx = { workspaceId: b4, actor: { id: wade4!.id, email: wade4!.email } };
const k4 = <T>(fn: (tx: Tx, c: Ctx) => Promise<T>) => withWorkspace({ workspaceId: b4, personId: wade4!.id }, (tx) => fn(tx, ctx4));
const last4 = async (chatId: string) => (await k4((tx, c) => readChat(tx, c, chatId))).messages.at(-1)!;
const t4 = Date.now();
const packIds: string[] = [];
for (const f of STEP4.files) packIds.push((await k4((tx, c) => saveUpload(tx, c, { name: f.split("/").pop()!, body: readFileSync(f) }))).id);
const chat4 = (await k4((tx, c) => send(tx, c, null, STEP4.message, packIds))).chatId;
await runQueued(b4);
const plan4 = await last4(chat4);
console.log(`→ 4b ${plan4.status}: ${plan4.text || JSON.stringify(plan4.parts).slice(0, 600)}`);
if (plan4.status !== "done") throw new Error("The build plan didn't finish; nothing after it was recorded.");
await k4((tx, c) => build.startBuild(tx, c, chat4, "Build all"));
await runQueued(b4);
let built4 = await last4(chat4);
if (built4.parts.some((p) => p.kind === "buttons")) {
  console.log(`→ 4c question: ${JSON.stringify(built4.parts.filter((p) => p.kind === "text" || p.kind === "buttons"))}`);
  await k4((tx, c) => build.answerBuild(tx, c, chat4, 0));
  await runQueued(b4);
  built4 = await last4(chat4);
}
console.log(`→ 4d ${built4.status}: ${built4.text} ${JSON.stringify(built4.parts).slice(0, 1500)}`);
console.log(`Step 4 took ${Math.round((Date.now() - t4) / 1000)} s`);
if (built4.status !== "done") throw new Error("Build all didn't finish.");

// 7c: Wade drops the Juniper Health signed contract on a new contract, in a Fernwood as seeded (Customer
// contracts as Playwright's Fernwood has it).
const { formReading } = await import("@/server/kernel/read-into-fields");
const { readIntoFormWith } = await import("@/server/ai-step/read-into-form");
const f7 = (await seedWorkspace({ subdomain: `rec7${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
await seedCapabilities(f7);
const [wade7] = await withWorkspace({ workspaceId: f7 }, (tx) => tx.select({ id: people.id, email: people.email }).from(people).where(sql`${people.email} = 'wade@fernwood.dev'`));
const ctx7: Ctx = { workspaceId: f7, actor: { id: wade7!.id, email: wade7!.email } };
const k7 = <T>(fn: (tx: Tx, c: Ctx) => Promise<T>) => withWorkspace({ workspaceId: f7, personId: wade7!.id }, (tx) => fn(tx, ctx7));
const contracts7 = (await k7((tx) => tx.execute<{ id: string }>(sql`select id from capabilities where name = 'Customer contracts'`)))[0]!.id;
const pdf7 = await k7((tx, c) => saveUpload(tx, c, { name: "Juniper Health signed contract.pdf", body: readFileSync("tests/files/Juniper Health signed contract.pdf") }));
const read7 = await readIntoFormWith(await k7((tx, c) => formReading(tx, c, contracts7, "contracts", pdf7.id)), pdf7.id, { workspaceId: f7, personId: wade7!.id, capabilityId: contracts7 });
console.log(`→ 7c: ${JSON.stringify(read7)}`);

// Step 11 (11a–11g, 12d): the report questions on a Fernwood with its report history, asked at Oct 26 10:02
// as the screens are, then Run again on Oct 27. seed/history/reports.ts has the questions.
const { STEP11 } = await import("@/seed/history/reports");
const { seedHistory, REPORT_ASKED } = await import("@/seed/history");
const { atInstant } = await import("@/server/kernel/clock");
const { reportsIn } = await import("@/server/kernel/report/store");
const { runAgain } = await import("@/server/chat/send");
const f8 = (await seedWorkspace({ subdomain: `rec8${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
await seedCapabilities(f8);
await seedHistory(f8);
const [wade8] = await withWorkspace({ workspaceId: f8 }, (tx) => tx.select({ id: people.id, email: people.email }).from(people).where(sql`${people.email} = 'wade@fernwood.dev'`));
const ctx8: Ctx = { workspaceId: f8, actor: { id: wade8!.id, email: wade8!.email } };
const k8 = <T>(fn: (tx: Tx, c: Ctx) => Promise<T>) => withWorkspace({ workspaceId: f8, personId: wade8!.id }, (tx) => fn(tx, ctx8));
const ask8 = async (chatId: string | null, text: string) => {
  const out = await atInstant(REPORT_ASKED, async () => {
    const o = await k8((tx, c) => send(tx, c, chatId, text, []));
    await runQueued(f8);
    return o;
  });
  const last = (await k8((tx, c) => readChat(tx, c, out.chatId))).messages.at(-1)!;
  console.log(`→ 11 ${last.status}: ${last.text}`);
  if (last.status !== "done") throw new Error("That report didn't finish; nothing after it was recorded.");
  return out.chatId;
};
const { listChats } = await import("@/server/kernel/chat-list");
const seeded = (await k8((tx, c) => listChats(tx, c))).find((c) => c.title === "Spend by team, Q4")!;
const byTeam = await ask8(null, STEP11.byTeam);
await ask8(byTeam, STEP11.engineering);
await ask8(null, STEP11.starters);
await ask8(null, STEP11.cloud);
// 12c–12d: Run again on the seeded chat (seed/history/chats.ts), as Playwright and the replay reopen it.
const firstRun = (await k8((tx, c) => reportsIn(tx, c, seeded.id)))[0]!;
await k8((tx, c) => runAgain(tx, c, seeded.id, firstRun.id));
await runQueued(f8);
console.log(`→ 12d: ${(await k8((tx, c) => readChat(tx, c, seeded.id))).messages.at(-1)!.text}`);

// M9: documents that try to direct Bike, through every door (tests/injected.ts), on a Fernwood with its capabilities.
const { plantedSequence } = await import("@/tests/injected");
const f9 = (await seedWorkspace({ subdomain: `rec9${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
await seedCapabilities(f9);
const planted = await plantedSequence(f9);
console.log(`→ planted: contract ${JSON.stringify(planted.contract)}`);

// M21: filters in plain words (tests/filter-words.ts), asked by Wade on a Fernwood as seeded.
const { FILTER_WORDS } = await import("@/tests/filter-words");
const { filterWordsInput } = await import("@/server/kernel/filter-words");
const { wordsToFilters } = await import("@/server/filters/words");
const { capabilities: capTable } = await import("@/db/schema");
const f10 = (await seedWorkspace({ subdomain: `rec10${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
await seedCapabilities(f10);
const [wade10] = await withWorkspace({ workspaceId: f10 }, (tx) => tx.select({ id: people.id }).from(people).where(sql`${people.email} = 'wade@fernwood.dev'`));
const k10 = <T>(fn: (tx: Tx, c: Ctx) => Promise<T>) => withWorkspace({ workspaceId: f10, personId: wade10!.id }, (tx) => fn(tx, { workspaceId: f10, actor: { id: wade10!.id, email: "wade@fernwood.dev" } }));
const caps10 = await withWorkspace({ workspaceId: f10 }, (tx) => tx.select({ id: capTable.id, name: capTable.name }).from(capTable));
for (const w of FILTER_WORDS) {
  const capId = caps10.find((c) => c.name === (w.sheet === "contracts" ? "Customer contracts" : "Spend"))!.id;
  const out = await wordsToFilters(await k10((tx, c) => filterWordsInput(tx, c, capId, w.sheet, w.text)), { workspaceId: f10, personId: wade10!.id, capabilityId: capId });
  console.log(`→ filters "${w.text}": ${JSON.stringify(out)}`);
}

// M24: tutorials on a Fernwood as Playwright's copies have it (seedFernwoodCopy: its admins too): Spend as Wade, Maya
// and Lena, Customer contracts as Wade.
const { tutorialFor } = await import("@/server/tutorials/write");
const { seedFernwoodCopy } = await import("@/seed");
const f11 = (await seedFernwoodCopy(`rec11${Date.now().toString(36)}`)).workspaceId;
const everyone11 = await withWorkspace({ workspaceId: f11 }, (tx) => tx.select({ id: people.id, email: people.email }).from(people));
const caps11 = await withWorkspace({ workspaceId: f11 }, (tx) => tx.select({ id: capTable.id, name: capTable.name }).from(capTable));
for (const [email, capName] of [["wade@fernwood.dev", "Spend"], ["maya@fernwood.dev", "Spend"], ["lena@fernwood.dev", "Spend"], ["wade@fernwood.dev", "Customer contracts"]] as const) {
  const p = everyone11.find((x) => x.email === email)!;
  const capId = caps11.find((c) => c.name === capName)!.id;
  const out = await tutorialFor({ workspaceId: f11, actor: { id: p.id, email } }, capId);
  console.log(`→ tutorial ${capName} for ${email}: ${out.ok ? out.state.tutorial.steps.map((s) => s.title).join(" · ") : out.error}`);
}

// E1: the app sets' tutorials, for every app and every person, on the school and the firm as the flows seed them
// (school-g3, firm-g4): opening an app asks for its tutorial in the background, and no flow waits for it. Each person
// with the same access shares one request, so this records each kind once.
const { seedSchool, seedServicesFirm } = await import("@/seed");
const { AccessError } = await import("@/server/kernel/context");
const sets: string[] = [];
for (const seedSet of [seedSchool, seedServicesFirm]) {
  const id = (await seedSet(`rece1${sets.length}${Date.now().toString(36)}`)).workspaceId;
  sets.push(id);
  const everyone = await withWorkspace({ workspaceId: id }, (tx) => tx.select({ id: people.id, email: people.email }).from(people).orderBy(people.email));
  const caps = await withWorkspace({ workspaceId: id }, (tx) => tx.select({ id: capTable.id, name: capTable.name }).from(capTable).orderBy(capTable.name));
  for (const cap of caps)
    for (const p of everyone) {
      // Someone who can't see the app gets no tutorial for it: the kernel refuses, as it should.
      const out = await tutorialFor({ workspaceId: id, actor: { id: p.id, email: p.email } }, cap.id).catch((e) => (e instanceof AccessError ? null : Promise.reject(e)));
      if (out && !out.ok) console.log(`→ tutorial ${cap.name} for ${p.email}: ${out.error}`);
    }
  console.log(`→ E1 tutorials: ${caps.length} apps × ${everyone.length} people`);
}

// Every call this run logged (the AI calls carry the app's clock, so they are found by workspace): the
// failures one by one, then each prompt's calls and their cost in dollars (the hosted cost report, with credits
// and builds, is `pnpm ai:cost --test`).
const calls = [];
for (const id of [ws, ft, fl, fd, fw, fr, c1, c2, c3, b4, f7, f8, f9, f10, f11, ...sets])
  calls.push(
    ...(await withWorkspace({ workspaceId: id }, (tx) =>
      tx.select({ prompt: aiCalls.prompt, version: aiCalls.version, model: aiCalls.model, passed: aiCalls.passed, problem: aiCalls.problem, cost: aiCalls.costUsd, ms: aiCalls.ms, attempt: aiCalls.attempt, tokensIn: aiCalls.tokensIn, tokensOut: aiCalls.tokensOut, cacheRead: aiCalls.cacheRead, cacheWrite: aiCalls.cacheWrite, chatId: aiCalls.chatId }).from(aiCalls),
    )),
  );
for (const x of calls.filter((c) => !c.passed)) console.log(`${x.prompt} · ${x.model} · failed: ${x.problem} · $${Number(x.cost).toFixed(4)}`);
const perPrompt = new Map<string, { n: number; cost: number }>();
for (const c of calls) {
  const p = perPrompt.get(c.prompt) ?? { n: 0, cost: 0 };
  perPrompt.set(c.prompt, { n: p.n + 1, cost: p.cost + Number(c.cost) });
}
console.log("Recorded (replayed calls cost nothing new)");
for (const [prompt, p] of [...perPrompt].sort((x, y) => y[1].cost - x[1].cost)) console.log(`  ${prompt} · ${p.n} calls · $${p.cost.toFixed(4)}`);
console.log(`  Total · ${calls.length} calls · $${calls.reduce((t, c) => t + Number(c.cost), 0).toFixed(4)}`);

// Recordings this sequence no longer sends are removed, so none go stale; those a Playwright flow recorded
// (E2E_RECORD=1, listed in e2e-used.txt) stay.
const dir = path.join(process.cwd(), "server/ai/fixtures");
const listed = path.join(dir, "e2e-used.txt");
const e2eUsed = new Set((existsSync(listed) ? readFileSync(listed, "utf8") : "").split("\n").filter(Boolean).map((f) => path.join(process.cwd(), f)));
for (const prompt of readdirSync(dir).filter((d) => statSync(path.join(dir, d)).isDirectory())) {
  for (const f of readdirSync(path.join(dir, prompt))) {
    const file = path.join(dir, prompt, f);
    if (!usedFixtures.has(file) && !e2eUsed.has(file)) {
      rmSync(file);
      console.log(`removed ${prompt}/${f} (not used)`);
    }
  }
  if (!readdirSync(path.join(dir, prompt)).length) rmSync(path.join(dir, prompt), { recursive: true });
}
await closeDb();
