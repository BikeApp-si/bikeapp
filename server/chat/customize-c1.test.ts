import { beforeAll, describe, expect, it } from "vitest";
import { fillToSheetLimit } from "@/tests/at-limit";
import { eq } from "drizzle-orm";
import { capabilities, people } from "@/db/schema";
import { seedWorkspace } from "@/seed";
import { seedCapabilities } from "@/seed/capabilities";
import { FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES } from "@/seed/fernwood";
import { createCapability } from "@/server/kernel/capabilities";
import { plansIn, readChat, type Message } from "@/server/kernel/chats";
import type { KernelCtx } from "@/server/kernel/context";
import { applyCustomize } from "@/server/kernel/customize/apply";
import { salesLeadsFile } from "@/server/kernel/fixtures";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { C1 } from "@/tests/customize-c1";
import { sendCustomize } from "./customize";
import type { CustomizeDraft } from "./types";

// C1's requests, replayed from recorded answers in the order scripts/ai-record.ts recorded them, on a Fernwood with
// Sales leads added. Each ends in a preview that applies (Apply is tried and rolled back, so the next request
// sees the capability as the recording did), or one question with choices (each checked by the kernel before it
// was offered), or, for Hiring at its limit, a plain refusal, then a question rather than the same refusal.

let ws: string;
const ids = new Map<string, string>();
const as = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: ws, personId: ids.get("wade") }, (tx) => fn(tx, { workspaceId: ws, actor: { id: ids.get("wade")!, email: "wade@fernwood.dev" } }));
const capNamed = (name: string) => as((tx) => tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, name))).then((r) => r[0]!.id);

beforeAll(async () => {
  ws = (await seedWorkspace({ subdomain: `c1${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
  await seedCapabilities(ws);
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    for (const p of await tx.select({ id: people.id, email: people.email }).from(people)) ids.set(p.email.split("@")[0]!, p.id);
  });
  await as((tx, c) => createCapability(tx, c, salesLeadsFile([ids.get("wade")!, ids.get("dev")!]), { source: "build" }));
  await fillToSheetLimit(ws, "Hiring");
}, 180_000);

async function say(capName: string, text: string): Promise<{ chatId: string; reply: Message }> {
  const capId = await capNamed(capName);
  const out = await as((tx, c) => sendCustomize(tx, c, capId, text));
  await out.work();
  return { chatId: out.chatId, reply: (await as((tx, c) => readChat(tx, c, out.chatId))).messages.at(-1)! };
}

class Rollback extends Error {}
// The preview applies: the kernel saves it, then the transaction is rolled back.
async function applies(chatId: string): Promise<CustomizeDraft> {
  const plan = (await as((tx, c) => plansIn(tx, c, chatId))).findLast((p) => p.status === "waiting")!;
  const draft = plan.draft as CustomizeDraft;
  await expect(
    as(async (tx, c) => {
      await applyCustomize(tx, c, draft.capabilityId, new Map(draft.edits), chatId, draft.title);
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
  return draft;
}

// A preview that applies, or one question with choices; never the pilot's refusal.
async function endsWell(capName: string, text: string) {
  const r = await say(capName, text);
  expect(r.reply.status).toBe("done");
  expect(r.reply.text).not.toMatch(/needs a person column|Role .+ ›/);
  if (r.reply.parts.some((p) => p.kind === "change")) return { kind: "change" as const, draft: await applies(r.chatId) };
  const buttons = r.reply.parts.find((p) => p.kind === "buttons");
  expect(buttons, `Neither a preview nor a question: ${r.reply.text}`).toBeDefined();
  return { kind: "question" as const, labels: buttons!.kind === "buttons" ? buttons!.buttons.map((b) => b.label) : [] };
}

describe("Sales leads: five ways of asking for companies", () => {
  for (const [i, text] of C1.salesLeads.entries())
    it(`${i + 1}. “${text}”`, async () => {
      const out = await endsWell("Sales leads", text);
      if (out.kind === "question") expect(out.labels.length).toBeGreaterThanOrEqual(2);
      else expect(new Map(out.draft.edits).get(out.draft.capabilityId)!.after.sheets.length).toBeGreaterThan(1);
    });
});

describe("Onboarding: a sheet that hangs off a plan", () => {
  it("previews equipment its managers see through the plan, and it applies", async () => {
    const out = await endsWell("Onboarding", C1.onboarding);
    expect(out.kind).toBe("change");
  });
});

describe("Hiring, at its limit of 6 sheets", () => {
  let first: string;
  it("is refused in plain words, or offered choices that work", async () => {
    const r = await say("Hiring", C1.hiring);
    expect(r.reply.status).toBe("done");
    expect(r.reply.parts.some((p) => p.kind === "change")).toBe(false);
    expect(r.reply.text).not.toMatch(/Later|Role .+ ›/);
    first = r.reply.text;
  });

  it("asked again, never gives the same answer twice", async () => {
    const r = await say("Hiring", C1.hiring);
    expect(r.reply.status).toBe("done");
    expect(r.reply.text).not.toBe(first);
  });
});
