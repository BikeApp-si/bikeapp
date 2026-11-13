import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditEntries, capabilities, people } from "@/db/schema";
import { seedWorkspace } from "@/seed";
import { seedCapabilities } from "@/seed/capabilities";
import { FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES } from "@/seed/fernwood";
import { createCapability, getFile } from "@/server/kernel/capabilities";
import { plansIn, readChat, type Message } from "@/server/kernel/chats";
import type { KernelCtx } from "@/server/kernel/context";
import { salesLeadsFile } from "@/server/kernel/fixtures";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { C2 } from "@/tests/customize-c2";
import { applyFromChat, sendCustomize, UNSURE, type Via } from "./customize";

// C2's messages, replayed from recorded answers in the order scripts/ai-record.ts recorded them, on a Fernwood with
// Sales leads: a question gets a guide answer that changes nothing; its suggestion, pressed, is a preview; a sheet with
// no owner is applied; then why, what Bike can't do, and a word or two (Do it or Explain first).

let ws: string;
let cap: string;
let chatId: string;
const ids = new Map<string, string>();
const as = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: ws, personId: ids.get("wade") }, (tx) => fn(tx, { workspaceId: ws, actor: { id: ids.get("wade")!, email: "wade@fernwood.dev" } }));

beforeAll(async () => {
  ws = (await seedWorkspace({ subdomain: `c2${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
  await seedCapabilities(ws);
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    for (const p of await tx.select({ id: people.id, email: people.email }).from(people)) ids.set(p.email.split("@")[0]!, p.id);
  });
  cap = (await as((tx, c) => createCapability(tx, c, salesLeadsFile([ids.get("wade")!, ids.get("dev")!]), { source: "build" }))).id;
}, 180_000);

async function say(text: string, via: Via = "typed"): Promise<Message> {
  const out = await as((tx, c) => sendCustomize(tx, c, cap, text, via));
  chatId = out.chatId;
  await out.work();
  const reply = (await as((tx, c) => readChat(tx, c, out.chatId))).messages.at(-1)!;
  expect(reply.status).toBe("done");
  return reply;
}
const buttons = (m: Message) => m.parts.flatMap((p) => (p.kind === "buttons" ? p.buttons : []));
const guidePart = (m: Message) => m.parts.find((p) => p.kind === "guide");
const saved = () => as(async (tx) => ({ version: (await getFile(tx, cap))!.version, plans: (await plansIn(tx, { workspaceId: ws, actor: { id: ids.get("wade")!, email: "wade@fernwood.dev" } }, chatId)).length, audit: (await tx.select({ id: auditEntries.id }).from(auditEntries).where(eq(auditEntries.capabilityId, cap))).length }));

describe("Sales leads: Customize that explains", () => {
  let first: { action: string; label: string };

  it("“tell me the steps” gets numbered steps, marked as explaining, and changes nothing", async () => {
    const reply = await say(C2.steps);
    expect(guidePart(reply)).toBeDefined();
    // Numbered steps, perhaps after a line that leads into them; the AI's layout around them may vary.
    expect(reply.text).toMatch(/^1\. .+\n\n?2\. /m);
    expect(await saved()).toEqual({ version: 1, plans: 0, audit: 1 });
    // Its suggestions were checked by the kernel; each goes to the planner.
    expect(buttons(reply).length).toBeGreaterThan(0);
    expect(buttons(reply).every((b) => b.action === "plan")).toBe(true);
    first = buttons(reply)[0]!;
  });

  it("its first suggestion, pressed, is a preview that would apply", async () => {
    const reply = await say(first.label, "plan");
    expect(reply.parts).toEqual([{ kind: "change", planId: expect.any(String) }]);
  });

  it("a sheet with no owner applies; then “why can't lead owners see companies?” is explained, pointing at who sees what", async () => {
    await say(C2.noOwner);
    const plan = (await as((tx, c) => plansIn(tx, c, chatId))).findLast((p) => p.status === "waiting")!;
    const applied = await as((tx, c) => applyFromChat(tx, c, chatId, plan.id));
    await applied.work();
    const before = await saved();
    const reply = await say(C2.why);
    expect(guidePart(reply)).toEqual({ kind: "guide", section: "Who can see and do what" });
    expect(await saved()).toEqual(before);
  });

  it("what Bike can't do is said, with only requests that work", async () => {
    const reply = await say(C2.slack);
    expect(guidePart(reply)).toBeDefined();
    expect(reply.text).toMatch(/can't/);
    expect(reply.text).toMatch(/email/i);
    expect(buttons(reply).every((b) => b.action === "plan")).toBe(true);
  });

  it("a word or two asks Do it or Explain first; Explain first explains it", async () => {
    const asked = await say(C2.unsure);
    expect(asked.text).toBe(UNSURE);
    expect(buttons(asked).map((b) => b.label)).toEqual(["Do it", "Explain first"]);
    const reply = await say("Explain first", "explain_first");
    expect(guidePart(reply)).toBeDefined();
    expect((await as((tx) => tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.id, cap)))).length).toBe(1);
  });
});
