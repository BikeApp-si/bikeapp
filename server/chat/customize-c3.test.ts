import { beforeAll, describe, expect, it } from "vitest";
import { fillToSheetLimit } from "@/tests/at-limit";
import { eq } from "drizzle-orm";
import { capabilities, people } from "@/db/schema";
import { seedWorkspace } from "@/seed";
import { seedCapabilities } from "@/seed/capabilities";
import { FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES } from "@/seed/fernwood";
import { createCapability, getFile } from "@/server/kernel/capabilities";
import { plansIn, readChat, type Message, type Part } from "@/server/kernel/chats";
import type { KernelCtx } from "@/server/kernel/context";
import { applyCustomize } from "@/server/kernel/customize/apply";
import { salesLeadsFile } from "@/server/kernel/fixtures";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { addIncomeExpenses, C3 } from "@/tests/customize-c3";
import { sendCustomize, type Via } from "./customize";
import type { CustomizeDraft } from "./types";

// C3's questions, replayed from recorded answers in the order scripts/ai-record.ts recorded them: advice, grouped,
// with fields and where each item lives; buttons only for changes the kernel would apply, never more new sheets than
// the capability has room for; links to Home for what is its own capability or a report. Advice changes nothing.

let ws: string;
const ids = new Map<string, string>();
const as = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: ws, personId: ids.get("wade") }, (tx) => fn(tx, { workspaceId: ws, actor: { id: ids.get("wade")!, email: "wade@fernwood.dev" } }));
const capNamed = (name: string) => as((tx) => tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, name))).then((r) => r[0]!.id);

beforeAll(async () => {
  ws = (await seedWorkspace({ subdomain: `c3${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
  await seedCapabilities(ws);
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    for (const p of await tx.select({ id: people.id, email: people.email }).from(people)) ids.set(p.email.split("@")[0]!, p.id);
  });
  await as((tx, c) => createCapability(tx, c, salesLeadsFile([ids.get("wade")!, ids.get("dev")!]), { source: "build" }));
  await as((tx, c) => addIncomeExpenses(tx, c));
  await fillToSheetLimit(ws, "Hiring");
}, 180_000);

async function say(capName: string, text: string, via: Via = "typed"): Promise<{ chatId: string; reply: Message }> {
  const capId = await capNamed(capName);
  const out = await as((tx, c) => sendCustomize(tx, c, capId, text, via));
  await out.work();
  const reply = (await as((tx, c) => readChat(tx, c, out.chatId))).messages.at(-1)!;
  expect(reply.status).toBe("done");
  return { chatId: out.chatId, reply };
}
type Advice = Extract<Part, { kind: "advice" }>;
const adviceOf = (m: Message) => m.parts.find((p): p is Advice => p.kind === "advice")!;
const buttons = (m: Message) => m.parts.flatMap((p) => (p.kind === "buttons" ? p.buttons : []));
const links = (m: Message) => m.parts.flatMap((p) => (p.kind === "link" ? [p] : []));
const version = (capName: string) => capNamed(capName).then((id) => as((tx) => getFile(tx, id))).then((f) => f!.version);

class Rollback extends Error {}

describe("Income and expenses: “what other sheets can be added here to improve this capability?”", () => {
  let reply: Message;
  let chatId: string;

  it("gets advice in groups, each item with why, fields and where it lives, and where to start", async () => {
    ({ reply, chatId } = await say("Income and expenses", C3.income));
    const a = adviceOf(reply);
    const items = a.groups.flatMap((g) => g.items);
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(a.groups.length).toBeGreaterThanOrEqual(2);
    expect(items.every((i) => i.why.length > 0)).toBe(true);
    // A change here has its fields, unless it's a rule ("a rule can add them on a set day"), which has none.
    expect(items.filter((i) => i.place === "here").every((i) => i.fields.length > 0 || /when|remind|ask|rule/i.test(i.title + i.why))).toBe(true);
    expect(a.start.length).toBeGreaterThan(0);
    // It read the counts: 2 of the 6 entries have no category.
    expect(JSON.stringify(a)).toMatch(/\b(2|two)\b[^.]*categor|categor[^.]*\b(2|two)\b/i);
  });

  it("changes nothing, and its buttons go to the planner; what's its own capability or a report links to Home, filled in", async () => {
    expect(await version("Income and expenses")).toBe(1);
    expect(await as((tx, c) => plansIn(tx, c, chatId))).toEqual([]);
    expect(buttons(reply).length).toBeGreaterThan(0);
    expect(buttons(reply).every((b) => b.action === "plan")).toBe(true);
    expect(links(reply).length).toBeGreaterThan(0);
    expect(links(reply).every((l) => l.href.startsWith("/home?ask=") && decodeURIComponent(l.href.slice("/home?ask=".length)).length > 0)).toBe(true);
  });

  it("its first button, pressed, is a preview that applies", async () => {
    const r = await say("Income and expenses", buttons(reply)[0]!.label, "plan");
    expect(r.reply.parts).toEqual([{ kind: "change", planId: expect.any(String) }]);
    const plan = (await as((tx, c) => plansIn(tx, c, r.chatId))).findLast((p) => p.status === "waiting")!;
    const draft = plan.draft as CustomizeDraft;
    await expect(
      as(async (tx, c) => {
        await applyCustomize(tx, c, draft.capabilityId, new Map(draft.edits), r.chatId, draft.title);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  });
});

describe("advice elsewhere", () => {
  it("Sales leads: “how can this be better?” gets advice", async () => {
    const { reply } = await say("Sales leads", C3.sales);
    expect(adviceOf(reply).groups.flatMap((g) => g.items).length).toBeGreaterThanOrEqual(3);
  });

  it("Hiring, at its 6 sheets: no new sheet is offered here", async () => {
    const { reply } = await say("Hiring", C3.hiring);
    expect(adviceOf(reply).groups.flatMap((g) => g.items).length).toBeGreaterThanOrEqual(3);
    expect(buttons(reply).some((b) => /\bsheet\b/i.test(b.label))).toBe(false);
  });

  it("Onboarding: “what am I missing?” gets advice, and nothing changes", async () => {
    const before = await version("Onboarding");
    const { reply } = await say("Onboarding", C3.onboarding);
    expect(adviceOf(reply)).toBeDefined();
    expect(await version("Onboarding")).toBe(before);
  });
});
