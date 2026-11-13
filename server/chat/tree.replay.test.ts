import { runQueued } from "@/server/jobs/run";
import "@/server/jobs/runners";
import { beforeAll, describe, expect, it } from "vitest";
import { people } from "@/db/schema";
import { seedWorkspace } from "@/seed";
import { seedCapabilities } from "@/seed/capabilities";
import { FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES } from "@/seed/fernwood";
import { addMessage, getPlan, readChat, startChat } from "@/server/kernel/chats";
import type { KernelCtx } from "@/server/kernel/context";
import { getFile } from "@/server/kernel/capabilities";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { TREES } from "@/tests/trees";
import { runCreate } from "./create";
import { runDesign } from "./design";
import type { PlanDraft } from "./types";

// Prompt 2 learns trees (0.5, M28): product categories that sit under each other, from Home's chat, replayed from
// the recorded answer (scripts/ai-record.ts) on a Fernwood without Customer contracts. Behaviour, not wording: the
// plan's sheet is a tree through a link to itself, and Create makes it one.

let ws: string;
const ids = new Map<string, string>();
const wade = () => ({ id: ids.get("wade")!, email: "wade@fernwood.dev" });
const as = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: ws, personId: ids.get("wade") }, (tx) => fn(tx, { workspaceId: ws, actor: wade() }));

beforeAll(async () => {
  ws = (await seedWorkspace({ subdomain: `ft${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
  await seedCapabilities(ws, { contracts: false });
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    for (const p of await tx.select({ id: people.id, email: people.email }).from(people)) ids.set(p.email.split("@")[0]!, p.id);
  });
});

describe("a tree from Home's chat", () => {
  it("plans categories as a tree, and Create makes one", async () => {
    const chat = (await as((tx, c) => startChat(tx, c, "capability", { text: TREES.build }))).chatId;
    const replyId = await as((tx, c) => addMessage(tx, c, chat, { from: "bike", text: "", status: "working" }));
    await runDesign({ workspaceId: ws, person: wade(), chatId: chat, replyId, text: TREES.build, documents: [] });
    const m = (await as((tx, c) => readChat(tx, c, chat))).messages.find((x) => x.id === replyId)!;
    expect(m.status).toBe("done");
    const planId = (m.parts[0] as { planId: string }).planId;
    const draft = (await as((tx, c) => getPlan(tx, c, planId))).draft as PlanDraft;
    const tree = draft.design.capability!.sheets.find((s) => s.kind === "tree")!;
    expect(tree).toBeDefined();
    const parent = tree.columns.find((c) => c.name === tree.tree_parent)!;
    expect(parent).toMatchObject({ type: "link" });

    const created = await as((tx, c) => addMessage(tx, c, chat, { from: "bike", text: "", status: "working" }));
    await runCreate({ workspaceId: ws, person: wade(), chatId: chat, replyId: created, planId, withImport: false, withoutRestructure: false });
    await runQueued(ws);
    const capId = (await as((tx, c) => getPlan(tx, c, planId))).capabilityId!;
    const sheet = (await as((tx) => getFile(tx, capId)))!.file.sheets.find((s) => s.kind === "tree")!;
    const col = sheet.columns.find((c) => c.id === sheet.tree!.parent)!;
    expect(col.link).toEqual({ sheet: sheet.id });
  });
});
