import { runQueued } from "@/server/jobs/run";
import "@/server/jobs/runners";
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { aiCalls, auditEntries, outbox, people } from "@/db/schema";
import { seedWorkspace } from "@/seed";
import { seedCapabilities } from "@/seed/capabilities";
import { FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES } from "@/seed/fernwood";
import { addMessage, getPlan, readChat, startChat } from "@/server/kernel/chats";
import type { KernelCtx } from "@/server/kernel/context";
import { getFile } from "@/server/kernel/capabilities";
import { listRows } from "@/server/kernel/rows";
import { capabilities } from "@/db/schema";
import { saveUpload } from "@/server/kernel/uploads";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { STEP5 } from "@/tests/step5";
import { runCreate } from "./create";
import { runDesign } from "./design";
import { runImport } from "./import";
import type { PlanDraft } from "./types";

// Customer contracts from the messages on 5a, 5c and 5g–5h, replayed from recorded answers on a Fernwood
// without it: the plan, the file checked for import, and Create with its 12 rows.

let ws: string;
const ids = new Map<string, string>();
const person = (n: string) => ({ id: ids.get(n)!, email: `${n}@fernwood.dev` });
const as = <T>(n: string, fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: ws, personId: ids.get(n) }, (tx) => fn(tx, { workspaceId: ws, actor: person(n) }));

beforeAll(async () => {
  ws = (await seedWorkspace({ subdomain: `fn${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
  await seedCapabilities(ws, { contracts: false });
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    for (const p of await tx.select({ id: people.id, email: people.email }).from(people)) ids.set(p.email.split("@")[0]!, p.id);
  });
});

// A message and Bike's reply, worked out as the app does after it answers.
async function say(chatId: string | null, text: string) {
  const chat = chatId ?? (await as("wade", (tx, c) => startChat(tx, c, "capability", { text }))).chatId;
  if (chatId) await as("wade", (tx, c) => addMessage(tx, c, chat, { from: "person", text }));
  const replyId = await as("wade", (tx, c) => addMessage(tx, c, chat, { from: "bike", text: "", status: "working" }));
  return { chat, replyId };
}
const reply = async (chat: string, id: string) => (await as("wade", (tx, c) => readChat(tx, c, chat))).messages.find((m) => m.id === id)!;

describe("Customer contracts from chat", () => {
  let chat: string;
  let planId: string;

  it("5a–5c: the message becomes a checked plan, with its Audit entry", async () => {
    const r = await say(null, STEP5.contracts);
    chat = r.chat;
    await runDesign({ workspaceId: ws, person: person("wade"), chatId: chat, replyId: r.replyId, text: STEP5.contracts, documents: [] });
    const m = await reply(chat, r.replyId);
    expect(m.status).toBe("done");
    expect(m.parts).toEqual([{ kind: "plan", planId: expect.any(String) }]);
    planId = (m.parts[0] as { planId: string }).planId;
    const plan = await as("wade", (tx, c) => getPlan(tx, c, planId));
    const draft = plan.draft as PlanDraft;
    // Behaviour, not the model's wording: a new Customer contracts with its two reminders, where Wade and
    // Krishna manage every contract and each owner works on their own.
    const capability = draft.design.capability!;
    expect(capability.name).toBe("Customer contracts");
    expect(draft.summary).toMatch(/^1 sheet, \d steps, 2 rules, \d roles$/);
    expect(draft.rules).toHaveLength(2);
    expect(draft.rules.map((r) => r.trigger.kind)).toEqual(["date_reached", "date_reached"]);
    const everyContract = capability.roles.filter((r) => r.scope === "all" && r.can.includes("edit")).flatMap((r) => r.people);
    expect(everyContract.sort()).toEqual(["krishna@fernwood.dev", "wade@fernwood.dev"]);
    expect(capability.roles.some((r) => r.scope === "own" && r.person_column?.column === "Owner")).toBe(true);
    const [entry] = await as("wade", (tx) => tx.select().from(auditEntries).where(and(eq(auditEntries.chatId, chat), eq(auditEntries.event, "plan.drafted"))));
    expect(entry!.details).toEqual({ plan: "Customer contracts", version: 1, summary: draft.summary });
    // Both prompts ran from recordings, and each call is in the AI log with its chat.
    const calls = await as("wade", (tx) => tx.select({ prompt: aiCalls.prompt, passed: aiCalls.passed }).from(aiCalls).where(eq(aiCalls.chatId, chat)));
    expect(calls).toEqual([{ prompt: "capability-designer", passed: true }, { prompt: "logic-writer", passed: true }]);
  });

  it("5g: an attached CSV is mapped and checked; 2 rows need a check", async () => {
    const up = await as("wade", (tx, c) => saveUpload(tx, c, { name: "contracts.csv", body: readFileSync("tests/files/contracts.csv") }));
    const r = await say(chat, STEP5.importNote);
    await runImport({ workspaceId: ws, person: person("wade"), chatId: chat, replyId: r.replyId, uploadId: up.id });
    expect((await reply(chat, r.replyId)).parts).toEqual([{ kind: "import", planId }]);
    const imported = ((await as("wade", (tx, c) => getPlan(tx, c, planId))).draft as PlanDraft).import!;
    expect(imported).toMatchObject({ fileName: "contracts.csv", rows: 12, columns: 9, unmapped: ["Notes", "Region", "Contract ID"] });
    expect(imported.checks).toEqual([
      { row: "Brightline", issue: "Owner “J. Bell” is not in People", action: "Set the owner to you" },
      { row: "Sable Analytics", issue: "No renewal date", action: "Set Renews on to Start + 1 year" },
    ]);
  });

  it("5h: Create and import 12 contracts, all at once; the plan is created and a ready email waits", async () => {
    const r = await say(chat, "Create and import 12 contracts");
    await runCreate({ workspaceId: ws, person: person("wade"), chatId: chat, replyId: r.replyId, planId, withImport: true, withoutRestructure: false });
    const m = await reply(chat, r.replyId);
    expect(m.status).toBe("done");
    const status = m.parts[0] as { rows: { label: string; state: string }[] };
    expect(status.rows.map((x) => [x.label, x.state])).toEqual([
      ["Sheet: Contracts", "done"], ["Steps", "done"], ["Access", "done"], ["Rules", "done"], ["Data: 12 rows", "done"], ["Overview and views", "done"], ["Connections", "done"],
    ]);
    const plan = await as("wade", (tx, c) => getPlan(tx, c, planId));
    expect(plan.status).toBe("created");
    const list = await as("wade", (tx, c) => listRows(tx, c, plan.capabilityId!, "contracts"));
    expect(list).toHaveLength(12);
    const by = new Map(list.map((x) => [x.data.customer, x]));
    expect(by.get("Brightline")!.data.owner).toBe(ids.get("wade"));
    expect(by.get("Sable Analytics")!.data.renews_on).toBe("2027-10-01"); // Start + 1 year
    expect(by.get("Northwind")!.stepId).toBe("renewal_due");
    const ready = await as("wade", (tx) => tx.select({ kind: outbox.kind, payload: outbox.payload }).from(outbox).where(eq(outbox.kind, "ready")));
    expect(ready).toEqual([{ kind: "ready", payload: { capabilityId: plan.capabilityId, capability: "Customer contracts" } }]);
  });

  it("is private to Wade: Lena, also an admin, can't read it", async () => {
    await expect(as("lena", (tx, c) => readChat(tx, c, chat))).rejects.toThrow("That chat doesn't exist.");
    await expect(as("maya", (tx, c) => startChat(tx, c, "capability", { text: "Hi" }))).rejects.toThrow("Only admins can do that.");
  });
});

describe("Supplier bills from chat, after Customer contracts (5j, 5k)", () => {
  const capNamed = (name: string) => as("wade", (tx) => tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, name))).then((r) => r[0]?.id);

  it("is created with its Also changes: purchase lines record what was received, and Budgets' Spent adds up Paid bills", async () => {
    const [spendId, toolsId] = [(await capNamed("Spend"))!, (await capNamed("Tools and budgets"))!];
    const before = (await as("wade", (tx) => getFile(tx, spendId)))!.file;
    const up = await as("wade", (tx, c) => saveUpload(tx, c, { name: "Purchasing policy.pdf", body: readFileSync("tests/files/Purchasing policy.pdf") }));
    const { send } = await import("./send");
    const sent = await as("wade", (tx, c) => send(tx, c, null, STEP5.bills, [up.id]));
    await runQueued(ws);
    const planMsg = (await as("wade", (tx, c) => readChat(tx, c, sent.chatId))).messages.at(-1)!;
    expect(planMsg.status).toBe("done");
    const planId = (planMsg.parts[0] as { planId: string }).planId;
    const draft = (await as("wade", (tx, c) => getPlan(tx, c, planId))).draft as PlanDraft;
    expect(draft.design.also_changes.filter((a) => a.kind === "add").length).toBeGreaterThan(0);

    const r = await say(sent.chatId, "Create Supplier bills and the changes");
    await runCreate({ workspaceId: ws, person: person("wade"), chatId: sent.chatId, replyId: r.replyId, planId, withImport: false, withoutRestructure: false });
    const done = await reply(sent.chatId, r.replyId);
    expect([done.status, done.text]).toEqual(["done", expect.any(String)]);
    const billsId = (await capNamed("Supplier bills"))!;

    // Purchase lines gained a number column for the quantity received.
    const spend = (await as("wade", (tx) => getFile(tx, spendId)))!.file;
    const lines = (f: typeof spend) => f.sheets.find((x) => x.id === "purchase_lines")!.columns;
    const added = lines(spend).filter((c) => !lines(before).some((b) => b.id === c.id));
    expect(added.some((c) => c.type === "number" && /receiv/i.test(c.name))).toBe(true);

    // Budgets gained a total of the bills that link to each budget, counting only those at Paid.
    const bills = (await as("wade", (tx) => getFile(tx, billsId)))!.file;
    const paid = bills.sheets.flatMap((x) => x.steps ?? []).find((st) => /paid/i.test(st.name))!;
    const budgets = (await as("wade", (tx) => getFile(tx, toolsId)))!.file.sheets.find((x) => x.id === "budgets")!;
    const spent = budgets.columns.find((c) => c.expr && typeof c.expr === "object" && "sumOf" in c.expr && c.expr.sumOf.capability === billsId);
    expect(spent?.expr).toMatchObject({ sumOf: { capability: billsId, steps: [paid.id] } });
    // A purchase can move on past Received to the new step.
    const purchases = spend.sheets.find((x) => x.id === "purchases")!;
    expect(purchases.steps!.find((st) => st.id === "received")!.end).toBeUndefined();
  });
});
