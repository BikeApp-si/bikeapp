"use server";

import { after } from "next/server";
import { asAction } from "@/server/auth/kernel-call";
import { applyFromChat, sendCustomize, type Via, type Work } from "@/server/chat/customize";
import { customizeView } from "@/server/chat/customize-view";

// The Customize tab (admins): each call is a kernel call as the signed-in person, and the kernel refuses
// anyone else. The work a message or Apply starts runs after the response; the page polls the chat.

// via: where a button's message goes (C2); typed messages go to the router. The kernel checks it.
export async function sendToCustomize(capabilityId: string, text: string, via: Via = "typed") {
  let work: Work | undefined;
  const r = await asAction(async (tx, ctx) => {
    const out = await sendCustomize(tx, ctx, capabilityId, text, via);
    work = out.work;
    return { chatId: out.chatId };
  });
  if (r.ok && work) after(work);
  return r;
}

export async function applyCustomizeDraft(chatId: string, planId: string) {
  let work: Work | undefined;
  const r = await asAction(async (tx, ctx) => {
    work = (await applyFromChat(tx, ctx, chatId, planId)).work;
    return {};
  });
  if (r.ok && work) after(work);
  return r;
}

export async function loadCustomize(capabilityId: string) {
  return asAction(async (tx, ctx) => ({ view: await customizeView(tx, ctx, capabilityId) }));
}
