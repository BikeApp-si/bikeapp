import { addMessage, plansIn, readChat, startChat, waitingPlan, type Part } from "@/server/kernel/chats";
import { KernelError, type KernelCtx } from "@/server/kernel/context";
import { openUpload } from "@/server/kernel/uploads";
import { fileDetail } from "@/server/files/read";
import { readForBuild } from "@/server/files/documents";
import { SheetError } from "@/server/files/sheet-reader";
import type { Tx } from "@/server/kernel/tx";
import { enqueue } from "@/server/jobs/queue";
import type { BuildReadJob } from "./build-read";
import type { CreateJob } from "./create";
import type { ReportJob } from "./report";
import type { DesignJob } from "./design";
import type { ImportJob } from "./import";
import { importChecked, type ImportIntoJob } from "./import-into";

// An admin's message on Home, and what Bike does with it. The messages are written now, in the caller's
// transaction, with a job for the worker (the AI calls, Create), so the page can show it moving as it polls.

type Person = { id: string; email: string };

// uploadIds: files the person uploaded for this message. Each is opened here, which also checks they may.
// into: a capability to import the attached CSV into (5i's Import a spreadsheet), for a new chat.
export async function send(tx: Tx, ctx: KernelCtx, chatId: string | null, text: string, uploadIds: string[], into?: string): Promise<{ chatId: string }> {
  if (!text.trim() && !uploadIds.length) throw new KernelError("Type a message first.");
  const files = [];
  for (const id of uploadIds.slice(0, 5)) {
    const f = await openUpload(tx, ctx, id);
    files.push({ uploadId: id, name: f.name, body: f.body, detail: await fileDetail(f.name, f.body) });
  }
  const parts: Part[] = files.map((f) => ({ kind: "file", uploadId: f.uploadId, name: f.name, detail: f.detail }));
  const chat = chatId ?? (await startChat(tx, ctx, "capability", { text: text.trim(), parts })).chatId;
  if (chatId) await addMessage(tx, ctx, chat, { from: "person", text: text.trim(), parts });
  const replyId = await addMessage(tx, ctx, chat, { from: "bike", text: "", status: "working" });
  const job = { workspaceId: ctx.workspaceId, person: ctx.actor as Person, chatId: chat, replyId };

  // A reply in a report chat changes the report (11e).
  const kind = chatId ? (await readChat(tx, ctx, chat)).chat.kind : "capability";
  if (kind === "report") {
    await enqueue(tx, ctx, "report", { ...job, text: text.trim(), again: null } satisfies ReportJob, replyId);
    return { chatId: chat };
  }
  // A reply in a build chat plans the build again (4b), with any files it brings, until Build all.
  if (kind === "build") {
    const plans = await plansIn(tx, ctx, chat);
    const last = plans.at(-1);
    if (last && (last.status === "created" || (last.draft as { build?: unknown }).build)) throw new KernelError("This plan is being built, so it can’t change now.");
    await enqueue(tx, ctx, "build-read", { ...job, text: text.trim() } satisfies BuildReadJob, replyId);
    return { chatId: chat };
  }
  const csv = files.find((f) => /\.csv$/i.test(f.name));
  if (csv && into && !chatId) {
    await enqueue(tx, ctx, "import-into", { ...job, uploadId: csv.uploadId, capabilityId: into } satisfies ImportIntoJob, replyId);
    return { chatId: chat };
  }
  if (csv && (await waitingPlan(tx, ctx, chat))) {
    await enqueue(tx, ctx, "import", { ...job, uploadId: csv.uploadId } satisfies ImportJob, replyId);
    return { chatId: chat };
  }

  // Documents are read now (they are the person's own uploads) and go to the designer as data: the text of
  // Word and PDF files, and each table's name, header and row count, so it can tell a build (§5).
  const documents: DesignJob["documents"] = [];
  const tables: NonNullable<DesignJob["tables"]> = [];
  for (const f of files.filter((x) => !/\.(png|jpe?g)$/i.test(x.name))) {
    const read = await readForBuild(f.name, f.body).catch((e: unknown) => {
      throw e instanceof SheetError ? new KernelError(e.message) : e;
    });
    for (const d of read.docs) {
      if (d.kind === "text") documents.push({ name: d.name, pages: d.pages, text: d.text });
      else tables.push({ file: d.name, from: d.from, rows: Math.max(0, d.table.length - 1), header: d.table[0] ?? [] });
    }
  }
  await enqueue(tx, ctx, "design", { ...job, text: text.trim(), documents, tables } satisfies DesignJob, replyId);
  return { chatId: chat };
}

// Create from a plan (5h, 5j), or Go ahead without it (5l): the person's click is their message.
export async function create(
  tx: Tx,
  ctx: KernelCtx,
  chatId: string,
  planId: string,
  label: string,
  opts: { withImport: boolean; withoutRestructure: boolean },
): Promise<void> {
  await addMessage(tx, ctx, chatId, { from: "person", text: label });
  const replyId = await addMessage(tx, ctx, chatId, { from: "bike", text: "", parts: [{ kind: "creating", planId }], status: "working" });
  const job: CreateJob = { workspaceId: ctx.workspaceId, person: ctx.actor as Person, chatId, replyId, planId, ...opts };
  await enqueue(tx, ctx, "create", job, replyId);
}

// "Import N rows" (5i's Import a spreadsheet): done now, in this transaction; the click is the person's message.
export async function importNow(tx: Tx, ctx: KernelCtx, chatId: string, messageId: string, label: string) {
  await addMessage(tx, ctx, chatId, { from: "person", text: label });
  const done = await importChecked(tx, ctx, chatId, messageId);
  await addMessage(tx, ctx, chatId, { from: "bike", text: done.text, parts: done.parts });
}

// Run again (12c–12d): the click isn't a message; Bike's new reply runs the report's query now.
export async function runAgain(tx: Tx, ctx: KernelCtx, chatId: string, reportId: string): Promise<void> {
  const replyId = await addMessage(tx, ctx, chatId, { from: "bike", text: "", status: "working" });
  await enqueue(tx, ctx, "report", { workspaceId: ctx.workspaceId, person: ctx.actor as Person, chatId, replyId, text: "", again: { reportId } } satisfies ReportJob, replyId);
}
