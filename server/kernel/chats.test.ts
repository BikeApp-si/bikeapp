import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditEntries } from "@/db/schema";
import { kernelWorkspace } from "@/tests/kernel";
import { addMessage, getPlan, plansIn, readChat, renameChat, savePlan, startChat, touchChat, updateMessage, waitingPlan } from "./chats";

// Chats on Home: private to their author, Bike's messages written as they are worked on, plans in versions.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
beforeAll(async () => {
  k = await kernelWorkspace();
});

describe("chats", () => {
  it("keeps a chat's messages in order, and only Bike's change after they are sent", async () => {
    const { chatId, messageId } = await k.as("ada", (tx, c) => startChat(tx, c, "capability", { text: "Track contracts" }));
    const reply = await k.as("ada", (tx, c) => addMessage(tx, c, chatId, { from: "bike", text: "", status: "working" }));
    await k.as("ada", (tx, c) => updateMessage(tx, c, reply, { text: "Done.", status: "done" }));
    const { messages } = await k.as("ada", (tx, c) => readChat(tx, c, chatId));
    expect(messages.map((m) => [m.from, m.text, m.status])).toEqual([["person", "Track contracts", "done"], ["bike", "Done.", "done"]]);
    await expect(k.as("ada", (tx, c) => updateMessage(tx, c, messageId, { text: "Edited" }))).rejects.toThrow("Only Bike's messages change after they are sent.");
  });

  it("is the author's alone, and admins only start one", async () => {
    const { chatId } = await k.as("ada", (tx, c) => startChat(tx, c, "capability", { text: "Mine" }));
    await expect(k.as("priya", (tx, c) => readChat(tx, c, chatId))).rejects.toThrow("That chat doesn't exist.");
    await expect(k.as("priya", (tx, c) => startChat(tx, c, "capability", { text: "Hi" }))).rejects.toThrow("Only admins can do that.");
  });

  it("keeps plan versions: a new one replaces the waiting one, each with its Audit entry", async () => {
    const { chatId, messageId } = await k.as("ada", (tx, c) => startChat(tx, c, "capability", { text: "Plan" }));
    const v1 = await k.as("ada", (tx, c) => savePlan(tx, c, chatId, messageId, { a: 1 }, { name: "Contracts", summary: "1 sheet" }));
    const v2 = await k.as("ada", (tx, c) => savePlan(tx, c, chatId, messageId, { a: 2 }, { name: "Contracts", summary: "1 sheet, 2 rules" }));
    expect((await k.as("ada", (tx, c) => plansIn(tx, c, chatId))).map((p) => [p.version, p.status])).toEqual([[1, "replaced"], [2, "waiting"]]);
    expect((await k.as("ada", (tx, c) => waitingPlan(tx, c, chatId)))!.id).toBe(v2.id);
    expect((await k.as("ada", (tx, c) => getPlan(tx, c, v1.id))).draft).toEqual({ a: 1 });
    const events = await k.as("ada", (tx) => tx.select({ event: auditEntries.event, details: auditEntries.details }).from(auditEntries).where(and(eq(auditEntries.chatId, chatId))));
    expect(events).toEqual([
      { event: "plan.drafted", details: { plan: "Contracts", version: 1, summary: "1 sheet" } },
      { event: "plan.tweaked", details: { plan: "Contracts", version: 2, summary: "1 sheet, 2 rules" } },
    ]);
  });

  it("names a chat once, and adds the capabilities it touched; touching it again with nothing new changes nothing", async () => {
    const { chatId } = await k.as("ada", (tx, c) => startChat(tx, c, "capability", { text: "Name me" }));
    await k.as("ada", (tx, c) => touchChat(tx, c, chatId, { title: "Customer contracts" }));
    await k.as("ada", (tx, c) => touchChat(tx, c, chatId, { title: "Something else" }));
    await k.as("ada", (tx, c) => touchChat(tx, c, chatId, { capabilityIds: ["a"] }));
    await k.as("ada", (tx, c) => touchChat(tx, c, chatId, { capabilityIds: ["a", "b"] }));
    const { chat } = await k.as("ada", (tx, c) => readChat(tx, c, chatId));
    expect([chat.title, chat.capabilityIds]).toEqual(["Customer contracts", ["a", "b"]]);
  });

  it("names a Customize chat again by each change it applies; no other chat (12b)", async () => {
    const { chatId } = await k.as("ada", (tx, c) => startChat(tx, c, "customize", { text: "Add a legal review" }));
    await k.as("ada", (tx, c) => touchChat(tx, c, chatId, { title: "Customize Customer contracts" }));
    await k.as("ada", (tx, c) => renameChat(tx, c, chatId, "Customer contracts: Legal review step"));
    expect((await k.as("ada", (tx, c) => readChat(tx, c, chatId))).chat.title).toBe("Customer contracts: Legal review step");
    const other = await k.as("ada", (tx, c) => startChat(tx, c, "capability", { text: "Name me" }));
    await expect(k.as("ada", (tx, c) => renameChat(tx, c, other.chatId, "Something else"))).rejects.toThrow("Only a Customize chat is named again.");
  });
});
