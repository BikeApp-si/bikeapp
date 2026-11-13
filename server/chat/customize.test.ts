import { beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { auditEntries, capabilities, chats, people, rows } from "@/db/schema";
import { seedWorkspace } from "@/seed";
import { seedCapabilities } from "@/seed/capabilities";
import { FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES } from "@/seed/fernwood";
import { getFile } from "@/server/kernel/capabilities";
import { plansIn, readChat } from "@/server/kernel/chats";
import type { KernelCtx } from "@/server/kernel/context";
import { suggestionsFor } from "@/server/kernel/customize/suggestions";
import { moveStep } from "@/server/kernel/rows";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { STEP6 } from "@/tests/step6";
import { applyFromChat, applyParts, CHECK_PART, sendCustomize } from "./customize";
import type { CustomizeDraft } from "./types";

// Customize from the messages on 6c, 6f, 6l, 6k and 6h, replayed from recorded answers on the seeded Fernwood
// (Customer contracts at version 4, Hiring at 3), in the order scripts/ai-record.ts recorded them. The tests
// check what happens, not the model's wording.

let ws: string;
const ids = new Map<string, string>();
const person = (n: string) => ({ id: ids.get(n)!, email: `${n}@fernwood.dev` });
const as = <T>(n: string, fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: ws, personId: ids.get(n) }, (tx) => fn(tx, { workspaceId: ws, actor: person(n) }));
const capNamed = (name: string) => as("wade", (tx) => tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, name))).then((r) => r[0]!.id);
const fileOf = (id: string) => as("wade", (tx) => getFile(tx, id)).then((f) => f!);

beforeAll(async () => {
  ws = (await seedWorkspace({ subdomain: `cu${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
  await seedCapabilities(ws);
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    for (const p of await tx.select({ id: people.id, email: people.email }).from(people)) ids.set(p.email.split("@")[0]!, p.id);
  });
});

// A message in the Customize chat, and Bike's reply once its work is done.
async function say(capId: string, text: string) {
  const out = await as("wade", (tx, c) => sendCustomize(tx, c, capId, text));
  await out.work();
  const { messages } = await as("wade", (tx, c) => readChat(tx, c, out.chatId));
  return { chatId: out.chatId, reply: messages.at(-1)! };
}
const waitingDraft = async (chatId: string) => {
  const p = (await as("wade", (tx, c) => plansIn(tx, c, chatId))).findLast((x) => x.status === "waiting")!;
  return { id: p.id, draft: p.draft as CustomizeDraft };
};
async function apply(chatId: string) {
  const { id } = await waitingDraft(chatId);
  const out = await as("wade", (tx, c) => applyFromChat(tx, c, chatId, id));
  await out.work();
  return (await as("wade", (tx, c) => readChat(tx, c, chatId))).messages.at(-1)!;
}

describe("Customer contracts' Customize chat", () => {
  let contracts: string;
  let chat: string;

  it("6c: Legal review by Lena and the reminder at 90 days, previewed as the text will read; nothing is live yet", async () => {
    contracts = await capNamed("Customer contracts");
    const r = await say(contracts, STEP6.legal);
    chat = r.chatId;
    expect(r.reply.status).toBe("done");
    expect(r.reply.parts).toEqual([{ kind: "change", planId: expect.any(String) }]);
    const { draft } = await waitingDraft(chat);
    expect(draft.version).toBe(5);
    expect(draft.button).toBe(`Apply ${draft.changes.length} changes`);
    const after = new Map(draft.edits).get(contracts)!.after;
    const sheet = after.sheets[0]!;
    const legal = sheet.steps!.find((s) => s.name === "Legal review")!;
    // Between Signed and Active, only over $50,000.
    expect(sheet.steps!.map((s) => s.id).slice(0, 4)).toEqual(["draft", "signed", legal.id, "active"]);
    expect(legal.onlyWhen).toEqual({ op: "gt", args: [{ col: "value" }, 5_000_000] });
    expect(after.roles.find((r) => r.id === "managers")!.members).toMatchObject({ people: expect.arrayContaining([ids.get("lena")]) });
    // The reminder moves to 90 days: the same rule, not a second one.
    const remind = after.rules.filter((r) => r.trigger.kind === "date_reached" && r.trigger.date === "notice_date" && (r.trigger.offsetDays ?? 0) < -30);
    expect(remind.map((r) => [r.id, r.trigger.offsetDays])).toEqual([["remind_owner", -90]]);
    // Lena is asked at Legal review (a step that needs a decision waits on someone).
    expect(after.rules.some((r) => r.trigger.kind === "enters_step" && r.trigger.step === legal.id && r.actions.some((a) => a.kind === "ask_person" && a.person === ids.get("lena")))).toBe(true);
    expect((await fileOf(contracts)).version).toBe(4);
    const [entry] = await as("wade", (tx) => tx.select().from(auditEntries).where(and(eq(auditEntries.chatId, chat), eq(auditEntries.event, "customize.preview"))));
    expect(entry!.details).toMatchObject({ version: 5 });
  });

  it("6d → 6e: Apply runs the Part / Status list, then the capability is at version 5 with its own chips", async () => {
    const { draft } = await waitingDraft(chat);
    const title = async () => (await as("wade", (tx) => tx.select({ title: chats.title }).from(chats).where(eq(chats.id, chat))))[0]!.title;
    // 12b: named by what it changes once applied, not before.
    expect(await title()).toBe("Customize Customer contracts");
    expect(draft.title).toMatch(/^\S+( \S+){1,5}$/); // two to six words (M25)
    const m = await apply(chat);
    expect(await title()).toBe(`Customer contracts: ${draft.title}`);
    expect(m.status).toBe("done");
    expect(m.text).toBe("Applying the changes to Customer contracts. This takes a few seconds.");
    const status = m.parts.find((p) => p.kind === "status")!;
    expect(status.kind === "status" && status.rows.map((r) => [r.label, r.state])).toEqual(applyParts(draft).map((l) => [l, "done"]));
    expect(applyParts(draft).at(-1)).toBe(CHECK_PART);
    expect(m.parts.at(-1)).toEqual({ kind: "text", text: "Done. Customer contracts is at version 5." });
    expect((await fileOf(contracts)).version).toBe(5);
    const saved = await as("wade", (tx) => tx.select().from(auditEntries).where(and(eq(auditEntries.chatId, chat), eq(auditEntries.event, "customize.saved"))));
    expect(saved.map((e) => e.details)).toEqual([expect.objectContaining({ from: 4, to: 5 })]);
    // New chips for version 5, from the small model, each under 40 characters.
    const chips = await as("wade", (tx, c) => suggestionsFor(tx, c, contracts));
    expect(chips.length).toBeGreaterThanOrEqual(1);
    expect(chips.length).toBeLessThanOrEqual(3);
    expect(chips).not.toContain("Add a legal review for big contracts");
  });

  it("6f: a rule in words reads as When / Then with what it would have done; Add this rule saves version 6", async () => {
    const r = await say(contracts, STEP6.draftRule);
    expect(r.chatId).toBe(chat); // one continuing conversation
    const { draft } = await waitingDraft(chat);
    expect(draft.button).toBe("Add this rule");
    expect(draft.rule).toMatchObject({ daily: true, preview: { columns: ["Contract", "Owner", "Would have run"], rows: [] } });
    await apply(chat);
    const v6 = await fileOf(contracts);
    expect(v6.version).toBe(6);
    const added = v6.file.rules.find((x) => x.trigger.from === "added")!;
    expect(added.trigger).toMatchObject({ kind: "date_reached", offsetDays: 14 });
  });

  it("6l: a vague request gets one question with choices, and changes nothing", async () => {
    const r = await say(contracts, STEP6.vague);
    const buttons = r.reply.parts.find((p) => p.kind === "buttons");
    expect(buttons && buttons.kind === "buttons" && buttons.buttons.length).toBeGreaterThanOrEqual(2);
    expect((await as("wade", (tx, c) => plansIn(tx, c, chat))).filter((p) => p.status === "waiting")).toEqual([]);
    expect((await fileOf(contracts)).version).toBe(6);
  });

  it("6k: who owns one contract is changed in the Data tab; Bike says so and links there", async () => {
    const r = await say(contracts, STEP6.leo);
    expect(r.reply.parts).toEqual([{ kind: "link", label: "Open Contracts", href: `/c/${contracts}` }]);
    expect((await fileOf(contracts)).version).toBe(6);
  });

  it("is for admins only, in the kernel", async () => {
    await expect(as("maya", (tx, c) => sendCustomize(tx, c, contracts, STEP6.vague))).rejects.toThrow(/Only admins/);
  });
});

describe("Hiring's Customize chat", () => {
  it("6h → 6j: Hired, which holds 5 candidates, is renamed Offer accepted; the connection and the Filled rule move with it", async () => {
    const hiring = await capNamed("Hiring");
    const r = await say(hiring, STEP6.hired);
    const { draft } = await waitingDraft(r.chatId);
    expect(draft.renames).toEqual([
      {
        from: "Hired",
        to: "Offer accepted",
        count: 5,
        rows: { one: "candidate", many: "candidates" },
        insteadOfRemoval: true,
        uses: [
          { kind: "connection", text: "When a candidate is Offer accepted, start their onboarding plan with name, start date and manager." },
          { kind: "rule", text: "When a candidate is Offer accepted, their opening moves to Filled." },
        ],
      },
    ]);
    expect(draft.button).toBe("Apply with these fixes");
    expect(draft.collapsed.tail).toBe("1 connection and 1 rule moved to Offer accepted");
    const m = await apply(r.chatId);
    expect(m.parts.at(-1)).toEqual({ kind: "text", text: "Done. Hiring is at version 4." });
    expect((await fileOf(hiring)).file.sheets[1]!.steps!.find((s) => s.id === "hired")!.name).toBe("Offer accepted");

    // Sam Okafor reaches Offer accepted: his plan starts in Onboarding and his opening is Filled, as with Hired.
    const cands = await as("wade", (tx) => tx.select().from(rows).where(and(eq(rows.capabilityId, hiring), eq(rows.sheetId, "candidates"))).orderBy(asc(rows.seq)));
    const sam = cands.find((x) => (x.data as { name: string }).name === "Sam Okafor")!;
    await as("priya", (tx, c) => moveStep(tx, c, sam.id, "hired"));
    const plans = await as("wade", async (tx) => tx.select().from(rows).where(and(eq(rows.capabilityId, await capNamed("Onboarding")), eq(rows.sheetId, "plans"))));
    expect(plans.map((x) => (x.data as { name: string }).name)).toContain("Sam Okafor");
  });
});
