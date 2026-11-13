"use server";

import { asAction } from "@/server/auth/kernel-call";
import { answerBuild, startBuild } from "@/server/chat/build";
import { create, importNow, runAgain, send } from "@/server/chat/send";
import { chatView } from "@/server/chat/view";
import { saveUpload } from "@/server/kernel/uploads";

// Home's chat (admins): each call is a kernel call as the signed-in person. The work a message starts (the
// AI calls, Create) is a job for the worker, so the page shows it moving as it polls.

export async function sendMessage(chatId: string | null, text: string, uploadIds: string[], into?: string) {
  return asAction((tx, ctx) => send(tx, ctx, chatId, text, uploadIds, into));
}

export async function attachFile(form: FormData) {
  const file = form.get("file");
  if (!(file instanceof File)) return { ok: false as const, error: "Choose a file.", problems: [] };
  const body = new Uint8Array(await file.arrayBuffer());
  return asAction((tx, ctx) => saveUpload(tx, ctx, { name: file.name, body }).then((u) => ({ uploadId: u.id, name: u.name })));
}

export async function createFromPlan(chatId: string, planId: string, label: string, opts: { withImport: boolean; withoutRestructure: boolean }) {
  return asAction(async (tx, ctx) => (await create(tx, ctx, chatId, planId, label, opts), {}));
}

// Build all (4b), and the answer to 4c's question.
export async function buildAll(chatId: string, label: string) {
  return asAction(async (tx, ctx) => (await startBuild(tx, ctx, chatId, label), {}));
}

export async function answerBuildQuestion(chatId: string, choice: number) {
  return asAction(async (tx, ctx) => (await answerBuild(tx, ctx, chatId, choice), {}));
}

// Run again on a report (12c): a new reply with the same query, run now.
export async function runReportAgain(chatId: string, reportId: string) {
  return asAction(async (tx, ctx) => (await runAgain(tx, ctx, chatId, reportId), {}));
}

export async function loadChat(chatId: string) {
  return asAction(async (tx, ctx) => ({ view: await chatView(tx, ctx, chatId) }));
}

export async function importFromChat(chatId: string, messageId: string, label: string) {
  return asAction(async (tx, ctx) => (await importNow(tx, ctx, chatId, messageId, label), {}));
}
