import { and, asc, desc, eq } from "drizzle-orm";
import { chats, messages, plans } from "@/db/schema";
import { mustBeAdmin } from "./admin";
import { record } from "./audit";
import { AccessError, KernelError, load, type KernelCtx } from "./context";
import type { CheckedFile } from "./plans/import-check";
import { atomic, type Tx } from "./tx";
import { currentTime } from "./clock";

// Chats with Bike on Home (admins only), their messages and the plans in them. A chat is private to the
// admin who wrote it: RLS hides it from everyone else, and each call here checks it too.

// What a message holds besides its text. Chat replies are text and simple tables, with buttons for choices
// (brief › Behaviours); a Step / Status or Part / Status list shows work in progress.
export type Part =
  // 4c's Capability / Status / Rows: rows say how many came in ("46 of 46"), and a capability can wait on a question.
  | { kind: "status"; head: "Step" | "Part" | "Capability"; rows: { label: string; state: "done" | "doing" | "next" | "failed" | "waiting"; count?: string }[]; note?: string }
  | { kind: "table"; head?: string; columns: string[]; rows: string[][] }
  | { kind: "plan"; planId: string } // the plan card, with what follows it (attach hint, Create)
  | { kind: "import"; planId: string } // a file checked for import into the plan (5g)
  | { kind: "creating"; planId: string } // Create's Part / Status list (5h)
  // A file checked for import into a capability that exists (5i's Import a spreadsheet), and its import.
  | { kind: "import_rows"; capabilityId: string; capability: string; rows: { one: string; many: string }; draft: CheckedFile }
  | { kind: "imported"; messageId: string }
  | { kind: "file"; uploadId: string; name: string; detail: string }
  | { kind: "note"; tone: "warning"; title: string; text: string }
  | { kind: "buttons"; buttons: { action: string; label: string; primary?: boolean }[] }
  | { kind: "link"; label: string; href: string; outline?: boolean }
  | { kind: "change"; planId: string } // a Customize preview (6c, 6f, 6h), drawn from its draft
  // A Customize guide answer (C2): it explains and changes nothing; section is the heading of the text it's about,
  // refusal that it answers a change Bike couldn't make.
  | { kind: "guide"; section: string | null; refusal?: boolean }
  // Customize advice (C3): what to add first, later, and to look at on top; each item where Bike can build it.
  | { kind: "advice"; groups: { title: string; items: { title: string; why: string; fields: string[]; place: "here" | "capability" | "view" | "report" | "not_yet" }[] }[]; start: string }
  | { kind: "company"; planId: string } // a company rule's preview (0.2), drawn from its draft
  | { kind: "text"; text: string; muted?: boolean } // a paragraph after a table ("Done. Customer contracts is at version 5.")
  | { kind: "heading"; text: string } // "What I couldn't carry over" (4d)
  | { kind: "report"; reportId: string; brief?: boolean } // a report's chart, table, card and downloads (11c), drawn from its run; brief: the card and downloads only (a scheduled send, m33-c)
  // What an earlier reply in a build chat shrinks to once the chat has moved on (4c, 4d): "Building. … One question on Spend …".
  | { kind: "collapsed"; text: string };

export type Message = { id: string; from: "person" | "bike"; text: string; parts: Part[]; status: "working" | "done" | "failed"; at: Date };

export type ChatKind = "capability" | "customize" | "report" | "build" | "company";

async function mine(tx: Tx, ctx: KernelCtx, chatId: string) {
  const [chat] = await tx.select().from(chats).where(and(eq(chats.id, chatId), eq(chats.authorId, ctx.actor.id)));
  if (!chat) throw new AccessError("That chat doesn't exist.");
  return chat;
}

// A new chat, started by the admin's first message.
export async function startChat(tx: Tx, ctx: KernelCtx, kind: ChatKind, first: { text: string; parts?: Part[] }) {
  await mustBeAdmin(tx, ctx);
  const at = ctx.now ?? currentTime();
  const [chat] = await tx.insert(chats).values({ workspaceId: ctx.workspaceId, authorId: ctx.actor.id, kind, createdAt: at, updatedAt: at }).returning({ id: chats.id });
  const messageId = await addMessage(tx, ctx, chat!.id, { from: "person", text: first.text, parts: first.parts ?? [] });
  return { chatId: chat!.id, messageId };
}

export async function addMessage(tx: Tx, ctx: KernelCtx, chatId: string, m: { from: "person" | "bike"; text: string; parts?: Part[]; status?: Message["status"] }) {
  await mine(tx, ctx, chatId);
  if (m.from === "person" && !m.text.trim() && !m.parts?.length) throw new KernelError("Type a message first.");
  const at = ctx.now ?? currentTime();
  const [row] = await tx
    .insert(messages)
    .values({ workspaceId: ctx.workspaceId, chatId, from: m.from, text: m.text, parts: m.parts ?? [], status: m.status ?? "done", at })
    .returning({ id: messages.id });
  await tx.update(chats).set({ updatedAt: at }).where(eq(chats.id, chatId));
  return row!.id;
}

// A Bike message is written as it is worked on: its Step / Status list moves, then its reply replaces it.
export async function updateMessage(tx: Tx, ctx: KernelCtx, messageId: string, m: { text?: string; parts?: Part[]; status?: Message["status"] }) {
  const [msg] = await tx.select({ chatId: messages.chatId, from: messages.from }).from(messages).where(eq(messages.id, messageId));
  if (!msg) throw new AccessError("That message doesn't exist.");
  await mine(tx, ctx, msg.chatId);
  if (msg.from !== "bike") throw new KernelError("Only Bike's messages change after they are sent.");
  await tx.update(messages).set(m).where(eq(messages.id, messageId));
}

// The chat and its messages, oldest first.
export async function readChat(tx: Tx, ctx: KernelCtx, chatId: string) {
  const chat = await mine(tx, ctx, chatId);
  const list = await tx.select().from(messages).where(eq(messages.chatId, chatId)).orderBy(asc(messages.seq));
  return {
    chat,
    messages: list.map((m): Message => ({ id: m.id, from: m.from as Message["from"], text: m.text, parts: m.parts as Part[], status: m.status as Message["status"], at: m.at })),
  };
}

// The capabilities a chat touched and its title, once known.
export async function touchChat(tx: Tx, ctx: KernelCtx, chatId: string, set: { title?: string; capabilityIds?: string[] }) {
  const chat = await mine(tx, ctx, chatId);
  const ids = set.capabilityIds ? [...new Set([...(chat.capabilityIds as string[]), ...set.capabilityIds])] : undefined;
  const values = { ...(set.title && !chat.title ? { title: set.title } : {}), ...(ids ? { capabilityIds: ids } : {}) };
  if (Object.keys(values).length) await tx.update(chats).set(values).where(eq(chats.id, chatId));
}

// A Customize chat is named again by each change set it applies (12b); other chats keep their first title.
export async function renameChat(tx: Tx, ctx: KernelCtx, chatId: string, title: string) {
  const chat = await mine(tx, ctx, chatId);
  if (chat.kind !== "customize") throw new KernelError("Only a Customize chat is named again.");
  await tx.update(chats).set({ title: title.slice(0, 80) }).where(eq(chats.id, chatId));
}

// A new chat that asks a question about data becomes a report chat (prompt 2 says so, M8 decisions).
export async function turnIntoReport(tx: Tx, ctx: KernelCtx, chatId: string) {
  const chat = await mine(tx, ctx, chatId);
  if (chat.kind !== "capability") throw new KernelError("Only a new chat can become a report.");
  await tx.update(chats).set({ kind: "report" }).where(eq(chats.id, chatId));
}

// A new chat whose request needs several capabilities becomes a build (prompt 2 says so, §5 of the plan).
export async function turnIntoBuild(tx: Tx, ctx: KernelCtx, chatId: string) {
  const chat = await mine(tx, ctx, chatId);
  if (chat.kind !== "capability") throw new KernelError("Only a new chat can become a build.");
  await tx.update(chats).set({ kind: "build" }).where(eq(chats.id, chatId));
}

// --- plans ------------------------------------------------------------------------------------------------

export type StoredPlan = { id: string; version: number; draft: unknown; status: "waiting" | "replaced" | "created"; capabilityId: string | null; messageId: string | null };

const asPlan = (p: typeof plans.$inferSelect): StoredPlan => ({
  id: p.id,
  version: p.version,
  draft: p.draft,
  status: p.status as StoredPlan["status"],
  capabilityId: p.capabilityId,
  messageId: p.messageId,
});

// A new version of the chat's draft; it replaces the waiting one. In a Customize chat an applied draft is
// "created" too, and the next message starts a new one.
export async function saveDraft(tx: Tx, ctx: KernelCtx, chatId: string, messageId: string, draft: unknown) {
  await mine(tx, ctx, chatId);
  const [last] = await tx.select().from(plans).where(eq(plans.chatId, chatId)).orderBy(desc(plans.version)).limit(1);
  const version = (last?.version ?? 0) + 1;
  if (last?.status === "waiting") await tx.update(plans).set({ status: "replaced" }).where(eq(plans.id, last.id));
  const [row] = await tx.insert(plans).values({ workspaceId: ctx.workspaceId, chatId, messageId, version, draft, createdAt: ctx.now ?? currentTime() }).returning();
  return asPlan(row!);
}

// The admin's own Customize chat for a capability, one continuing conversation (developer notes §1).
export async function customizeChatFor(tx: Tx, ctx: KernelCtx, capabilityId: string): Promise<string | null> {
  await mustBeAdmin(tx, ctx);
  const found = await tx
    .select({ id: chats.id, capabilityIds: chats.capabilityIds })
    .from(chats)
    .where(and(eq(chats.authorId, ctx.actor.id), eq(chats.kind, "customize")))
    .orderBy(asc(chats.createdAt));
  return found.find((c) => (c.capabilityIds as string[]).includes(capabilityId))?.id ?? null;
}

// Where a chat opens (#12): a capability's Customize chat in its Customize tab (12e), the Company rules chat
// in Ontology (0.2), every other chat on Home (null). A Customize chat whose capability is gone stays on Home.
export function chatHome(chat: { kind: string; capabilityIds: unknown }, capabilityExists: (id: string) => boolean): string | null {
  if (chat.kind === "company") return "/ontology?tab=rules";
  const cap = (chat.capabilityIds as string[])[0];
  return chat.kind === "customize" && cap && capabilityExists(cap) ? `/c/${cap}?tab=customize` : null;
}

export async function chatPlace(tx: Tx, ctx: KernelCtx, chatId: string): Promise<string | null> {
  const chat = await mine(tx, ctx, chatId);
  const { files } = await load(tx);
  return chatHome(chat, (id) => files.has(id));
}

// The admin's own Company rules chat, one continuing conversation (0.2).
export async function companyChatFor(tx: Tx, ctx: KernelCtx): Promise<string | null> {
  await mustBeAdmin(tx, ctx);
  const [found] = await tx.select({ id: chats.id }).from(chats).where(and(eq(chats.authorId, ctx.actor.id), eq(chats.kind, "company"))).orderBy(asc(chats.createdAt)).limit(1);
  return found?.id ?? null;
}

// A checked plan in the chat. A new version replaces the waiting one; its Audit entry says which.
export async function savePlan(tx: Tx, ctx: KernelCtx, chatId: string, messageId: string, draft: unknown, words: { name: string; summary: string }) {
  return atomic(tx, async (tx) => {
    await mine(tx, ctx, chatId);
    const [last] = await tx.select().from(plans).where(eq(plans.chatId, chatId)).orderBy(desc(plans.version)).limit(1);
    if (last?.status === "created") throw new KernelError(`${words.name} has already been created.`);
    const version = (last?.version ?? 0) + 1;
    if (last) await tx.update(plans).set({ status: "replaced" }).where(eq(plans.id, last.id));
    const [row] = await tx.insert(plans).values({ workspaceId: ctx.workspaceId, chatId, messageId, version, draft, createdAt: ctx.now ?? currentTime() }).returning();
    await record(tx, ctx, {
      who: ctx.actor.email,
      event: version === 1 ? "plan.drafted" : "plan.tweaked",
      details: { plan: words.name, version, summary: words.summary },
      chatId,
      at: ctx.now,
    });
    return asPlan(row!);
  });
}

export async function getPlan(tx: Tx, ctx: KernelCtx, planId: string): Promise<StoredPlan & { chatId: string }> {
  const [p] = await tx.select().from(plans).where(eq(plans.id, planId));
  if (!p) throw new AccessError("That plan doesn't exist.");
  await mine(tx, ctx, p.chatId);
  return { ...asPlan(p), chatId: p.chatId };
}

export async function plansIn(tx: Tx, ctx: KernelCtx, chatId: string): Promise<StoredPlan[]> {
  await mine(tx, ctx, chatId);
  return (await tx.select().from(plans).where(eq(plans.chatId, chatId)).orderBy(asc(plans.version))).map(asPlan);
}

// The waiting plan in a chat, if there is one.
export async function waitingPlan(tx: Tx, ctx: KernelCtx, chatId: string): Promise<StoredPlan | null> {
  return (await plansIn(tx, ctx, chatId)).findLast((p) => p.status === "waiting") ?? null;
}

// A build's progress, kept with its plan as Build all goes (4c). It isn't a new version of the plan.
export async function saveBuildState(tx: Tx, ctx: KernelCtx, planId: string, draft: unknown) {
  const p = await getPlan(tx, ctx, planId);
  if (p.status !== "waiting") throw new KernelError("That plan has been replaced or built.");
  await tx.update(plans).set({ draft }).where(eq(plans.id, planId));
}

// Marks a plan created, once its change set is applied (changesets.ts).
export async function markCreated(tx: Tx, planId: string, capabilityId: string | null, changeSetId: string | null) {
  await tx.update(plans).set({ status: "created", capabilityId, changeSetId }).where(eq(plans.id, planId));
}

// A file to import on Create, checked by the kernel (5g), kept with the waiting plan. It isn't a new version
// of the plan: the plan is the same, with rows to bring in.
export async function attachImport(tx: Tx, ctx: KernelCtx, planId: string, imported: unknown) {
  const p = await getPlan(tx, ctx, planId);
  if (p.status !== "waiting") throw new KernelError("That plan has been replaced or created.");
  await tx.update(plans).set({ draft: { ...(p.draft as object), import: imported } }).where(eq(plans.id, planId));
}
