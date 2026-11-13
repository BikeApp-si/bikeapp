import { renderCapabilityPicture, type Picture } from "@/server/kernel/render-picture";
import { mustCustomize } from "@/server/kernel/capabilities";
import { and, desc, eq } from "drizzle-orm";
import { capabilityVersions, people, workspaces } from "@/db/schema";
import { customizeChatFor, plansIn, readChat, type Message } from "@/server/kernel/chats";
import { KernelError, load, type KernelCtx } from "@/server/kernel/context";
import { dateLines } from "@/server/kernel/chat-list";
import { suggestionsFor } from "@/server/kernel/customize/suggestions";
import { renderCapabilityText, versionLine, type TextSection } from "@/server/kernel/render-text";
import type { Tx } from "@/server/kernel/tx";
import type { CustomizeDraft } from "./types";
import { STALE_MS } from "./view";
import { currentTime } from "@/server/kernel/clock";

// The Customize tab as the page shows it (6b–6l): the capability's chat, each preview in it and where it
// stands, and the text on the right: as it is, as a waiting preview will read, or as it is being applied.

export type DraftState = "waiting" | "applying" | "applied" | "replaced";
export type DraftView = { id: string; state: DraftState; draft: CustomizeDraft };

export type CustomizeView = {
  capabilityId: string;
  name: string;
  chatId: string | null;
  messages: (Message & { stale: boolean })[];
  dates: Record<string, string>; // 12e: the date line above the first message of each day
  drafts: Record<string, DraftView>;
  working: boolean;
  applying: boolean;
  panel: { line: string; sections: TextSection[]; picture: Picture };
  chips: string[]; // empty once the chat has started
};

export async function customizeView(tx: Tx, ctx: KernelCtx, capabilityId: string, now = currentTime()): Promise<CustomizeView> {
  await mustCustomize(tx, ctx, capabilityId);
  const loaded = await load(tx);
  const cap = loaded.files.get(capabilityId);
  if (!cap) throw new KernelError("That app doesn't exist.");
  const chatId = await customizeChatFor(tx, ctx, capabilityId);
  const messages = chatId ? (await readChat(tx, ctx, chatId)).messages.map((m) => ({ ...m, stale: m.status === "working" && now.getTime() - m.at.getTime() > STALE_MS })) : [];
  const working = messages.some((m) => m.status === "working" && !m.stale);

  // A draft is being applied while the reply after the admin's Apply is still working.
  const drafts: Record<string, DraftView> = {};
  const stored = chatId ? await plansIn(tx, ctx, chatId) : [];
  const last = messages.at(-1);
  const applyingNow = !!last && last.from === "bike" && last.status === "working" && last.parts.some((p) => p.kind === "status" && p.head === "Part");
  for (const p of stored) {
    const state: DraftState = p.status === "created" ? "applied" : p.status === "replaced" ? "replaced" : applyingNow ? "applying" : "waiting";
    drafts[p.id] = { id: p.id, state, draft: p.draft as CustomizeDraft };
  }
  const open = Object.values(drafts).find((d) => d.state === "waiting" || d.state === "applying");

  const files = new Map([...loaded.files].map(([id, f]) => [id, f.file] as const));
  const personName = (id: string) => loaded.people.get(id)?.name;
  let file = cap.file;
  let line: string;
  if (open) {
    for (const [id, e] of open.draft.edits) files.set(id, e.after);
    file = files.get(capabilityId)!;
    line = versionLine({ version: open.draft.version, at: now, by: null }, now, loaded.timeZone, open.state === "applying" ? "updating" : "preview", loaded.formats);
  } else {
    const [v] = await tx
      .select({ at: capabilityVersions.createdAt, by: people.name })
      .from(capabilityVersions)
      .leftJoin(people, eq(people.id, capabilityVersions.createdBy))
      .where(and(eq(capabilityVersions.capabilityId, capabilityId), eq(capabilityVersions.version, cap.version)))
      .orderBy(desc(capabilityVersions.version))
      .limit(1);
    const [ws] = await tx.select({ timeZone: workspaces.timeZone }).from(workspaces);
    line = versionLine({ version: cap.version, at: v?.at ?? now, by: v?.by?.split(" ")[0] ?? null }, now, ws?.timeZone ?? loaded.timeZone, "saved", loaded.formats);
  }
  const textCtx = { capId: capabilityId, files, personName, viewerId: null, company: loaded.company?.rules, formats: loaded.formats };
  return {
    capabilityId,
    name: cap.file.name,
    chatId,
    messages,
    dates: dateLines(messages, loaded.timeZone, now, loaded.formats),
    drafts,
    working,
    applying: applyingNow,
    panel: {
      line,
      sections: renderCapabilityText(file, textCtx),
      // V1: the same file pictured; a waiting change is marked against the saved file it would replace.
      picture: renderCapabilityPicture(file, textCtx, open ? cap.file : null),
    },
    chips: messages.length ? [] : await suggestionsFor(tx, ctx, capabilityId),
  };
}
