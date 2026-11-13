import { beforeAll, describe, expect, it } from "vitest";
import { kernelWorkspace } from "@/tests/kernel";
import { contractsFile } from "@/server/kernel/fixtures";
import { addMessage, chatPlace, savePlan, startChat, touchChat } from "@/server/kernel/chats";
import { enqueue } from "@/server/jobs/queue";
import { eq } from "drizzle-orm";
import { jobs } from "@/db/schema";
import { listChats } from "@/server/kernel/chat-list";
import { chatView } from "./view";

// #12: a Customize chat opened from Chats showed "Something went wrong": Home drew its Customize change as a
// capability plan. A Customize chat opens in its capability's Customize tab (12e), Company rules in Ontology;
// Home still draws one without failing.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let cap: string;
beforeAll(async () => {
  k = await kernelWorkspace();
  cap = await k.create(contractsFile([k.id.ada]));
});

const customizeChat = async (capabilityId: string) => {
  const { chatId, messageId } = await k.as("ada", (tx, c) => startChat(tx, c, "customize", { text: "Add a legal review" }));
  await k.as("ada", (tx, c) => touchChat(tx, c, chatId, { title: "Customize Customer contracts", capabilityIds: [capabilityId] }));
  await k.as("ada", (tx, c) => savePlan(tx, c, chatId, messageId, { kind: "customize", capability: "Customer contracts", version: 2 }, { name: "Customer contracts", summary: "1 change" }));
  return chatId;
};

describe("where a chat opens (#12)", () => {
  it("opens a Customize chat in its capability's Customize tab, from Chats and from an old Home link", async () => {
    const chatId = await customizeChat(cap);
    const href = `/c/${cap}?tab=customize`;
    expect((await k.as("ada", (tx, c) => listChats(tx, c))).find((r) => r.id === chatId)?.href).toBe(href);
    expect(await k.as("ada", (tx, c) => chatPlace(tx, c, chatId))).toBe(href);
  });

  it("opens Company rules in Ontology, and every other chat on Home", async () => {
    const company = await k.as("ada", (tx, c) => startChat(tx, c, "company", { text: "Every expense needs a receipt" }));
    const plain = await k.as("ada", (tx, c) => startChat(tx, c, "capability", { text: "Track contracts" }));
    expect(await k.as("ada", (tx, c) => chatPlace(tx, c, company.chatId))).toBe("/ontology?tab=rules");
    expect(await k.as("ada", (tx, c) => chatPlace(tx, c, plain.chatId))).toBeNull();
    expect((await k.as("ada", (tx, c) => listChats(tx, c))).find((r) => r.id === plain.chatId)?.href).toBe(`/home?chat=${plain.chatId}`);
  });

  it("keeps a Customize chat on Home when its capability is gone, and draws it there without failing", async () => {
    const chatId = await customizeChat("a-deleted-capability");
    const view = await k.as("ada", (tx, c) => chatView(tx, c, chatId));
    expect(view.plans).toEqual({});
    expect(view.messages[0]!.text).toBe("Add a legal review");
    expect(await k.as("ada", (tx, c) => chatPlace(tx, c, chatId))).toBeNull();
  });
});

// Deploy #26 (Nov 9): Build all's job had ended at the one question, and the answer's job was building the same
// reply; read in the wrong order, the reply looked stopped and the page stopped asking for it.
describe("a reply still working", () => {
  it("hasn't stopped while any of its jobs is queued or running, in either order", async () => {
    for (const order of [["done", "running"], ["running", "done"]] as const) {
      const { chatId } = await k.as("ada", (tx, c) => startChat(tx, c, "capability", { text: "Set Bike up from these" }));
      const replyId = await k.as("ada", (tx, c) => addMessage(tx, c, chatId, { from: "bike", text: "Building.", status: "working" }));
      for (const status of order) {
        const id = await k.as("ada", (tx, c) => enqueue(tx, c, "build", {}, replyId));
        await k.as("ada", (tx) => tx.update(jobs).set({ status }).where(eq(jobs.id, id)));
      }
      const view = await k.as("ada", (tx, c) => chatView(tx, c, chatId));
      expect(view.messages.find((m) => m.id === replyId)?.stale).toBe(false);
      expect(view.working).toBe(true);
    }
  });

  it("has stopped once every job of it has ended", async () => {
    const { chatId } = await k.as("ada", (tx, c) => startChat(tx, c, "capability", { text: "Set Bike up from these" }));
    const replyId = await k.as("ada", (tx, c) => addMessage(tx, c, chatId, { from: "bike", text: "Building.", status: "working" }));
    for (const status of ["done", "failed"] as const) {
      const id = await k.as("ada", (tx, c) => enqueue(tx, c, "build", {}, replyId));
      await k.as("ada", (tx) => tx.update(jobs).set({ status }).where(eq(jobs.id, id)));
    }
    const view = await k.as("ada", (tx, c) => chatView(tx, c, chatId));
    expect(view.messages.find((m) => m.id === replyId)?.stale).toBe(true);
    expect(view.working).toBe(false);
  });
});
