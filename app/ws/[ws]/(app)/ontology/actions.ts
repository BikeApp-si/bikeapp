"use server";

import { after } from "next/server";
import { workspaces } from "@/db/schema";
import { asAction } from "@/server/auth/kernel-call";
import { applyCompanyFromChat, sendCompanyRules, type Work as CompanyWork } from "@/server/chat/company-rules";
import { companyRulesView } from "@/server/chat/company-rules-view";
import { mustBeAdmin } from "@/server/kernel/admin";
import { queueOntology } from "@/server/ontology/write";

// Regenerate (4e), and the page finding itself out of date: the Ontology is written again in the worker when
// what it reads from has changed, at most once every 10 minutes.
export async function regenerateOntology() {
  return asAction(async (tx, ctx) => {
    await mustBeAdmin(tx, ctx);
    await queueOntology(tx, ctx);
    return {};
  });
}

// The Company rules tab (0.2, admins): a message, Apply and the page's polling, each a kernel call as the signed-in
// person; the work a message or Apply starts runs after the response.
export async function sendToCompanyRules(text: string) {
  let work: CompanyWork | undefined;
  const r = await asAction(async (tx, ctx) => {
    const out = await sendCompanyRules(tx, ctx, text);
    work = out.work;
    return { chatId: out.chatId };
  });
  if (r.ok && work) after(work);
  return r;
}

export async function applyCompanyRulesDraft(chatId: string, planId: string) {
  let work: CompanyWork | undefined;
  const r = await asAction(async (tx, ctx) => {
    work = (await applyCompanyFromChat(tx, ctx, chatId, planId)).work;
    return {};
  });
  if (r.ok && work) after(work);
  return r;
}

export async function loadCompanyRules() {
  return asAction(async (tx, ctx) => {
    const [ws] = await tx.select({ name: workspaces.name }).from(workspaces);
    return { view: await companyRulesView(tx, ctx, ws!.name) };
  });
}
