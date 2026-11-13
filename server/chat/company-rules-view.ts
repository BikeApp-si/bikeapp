import { desc, eq } from "drizzle-orm";
import { companyRules, people } from "@/db/schema";
import { mustBeAdmin } from "@/server/kernel/admin";
import { companyChatFor, plansIn, readChat, type Message } from "@/server/kernel/chats";
import { dateLines } from "@/server/kernel/chat-list";
import { currentTime } from "@/server/kernel/clock";
import { load, type KernelCtx } from "@/server/kernel/context";
import { versionLine } from "@/server/kernel/render-text";
import type { CompanyRule } from "@/server/kernel/schema/company";
import type { Tx } from "@/server/kernel/tx";
import { placeOf } from "./company-rules";
import type { CompanyDraft } from "./types";
import { STALE_MS } from "./view";

// The Company rules tab as the page shows it (0.2): the admin's chat, each preview in it and where it stands, and
// the company's rules on the right, as they are, or as a waiting preview would leave them (that rule marked).

export type CompanyDraftView = { id: string; state: "waiting" | "applying" | "applied" | "replaced"; draft: CompanyDraft };
export type PanelRule = { id: string; text: string; appliesTo: string; marked: boolean };

export type CompanyRulesView = {
  company: string;
  chatId: string | null;
  messages: (Message & { stale: boolean })[];
  dates: Record<string, string>;
  drafts: Record<string, CompanyDraftView>;
  working: boolean;
  applying: boolean;
  panel: { line: string; rules: PanelRule[] };
  chips: string[]; // empty once the chat has started
};

// Examples to start from, while the chat is empty.
const CHIPS = ["Anything over $10,000 needs Lena's approval", "Tell the owner when anything waits more than 5 days", "Every new hire gets a laptop request in Spend"];

export async function companyRulesView(tx: Tx, ctx: KernelCtx, companyName: string, now = currentTime()): Promise<CompanyRulesView> {
  await mustBeAdmin(tx, ctx);
  const loaded = await load(tx);
  const chatId = await companyChatFor(tx, ctx);
  const messages = chatId ? (await readChat(tx, ctx, chatId)).messages.map((m) => ({ ...m, stale: m.status === "working" && now.getTime() - m.at.getTime() > STALE_MS })) : [];
  const last = messages.at(-1);
  const applyingNow = !!last && last.from === "bike" && last.status === "working" && last.parts.some((p) => p.kind === "status" && p.head === "Part");
  const drafts: Record<string, CompanyDraftView> = {};
  for (const p of chatId ? await plansIn(tx, ctx, chatId) : []) {
    if ((p.draft as { kind?: string }).kind !== "company") continue;
    drafts[p.id] = { id: p.id, state: p.status === "created" ? "applied" : p.status === "replaced" ? "replaced" : applyingNow ? "applying" : "waiting", draft: p.draft as CompanyDraft };
  }
  const open = Object.values(drafts).find((d) => d.state === "waiting" || d.state === "applying");

  const files = new Map([...loaded.files].map(([id, f]) => [id, f.file] as const));
  const shown = (rules: CompanyRule[], marked: string | null): PanelRule[] =>
    rules.map((r) => ({ id: r.id, text: r.text, appliesTo: r.applications.map((a) => placeOf(files, a.capabilityId, a.trigger.sheet)).join(", "), marked: r.id === marked }));
  let line: string;
  let rules: PanelRule[];
  if (open) {
    rules = shown(open.draft.rules, open.draft.ruleId);
    line = open.state === "applying" ? "Updating · not live yet" : "Preview · not live yet";
  } else if (loaded.company && loaded.company.rules.length) {
    const [v] = await tx.select({ at: companyRules.createdAt, by: people.name }).from(companyRules).leftJoin(people, eq(people.id, companyRules.createdBy)).orderBy(desc(companyRules.version)).limit(1);
    rules = shown(loaded.company.rules, null);
    line = versionLine({ version: loaded.company.version, at: v?.at ?? now, by: v?.by?.split(" ")[0] ?? null }, now, loaded.timeZone, "saved", loaded.formats);
  } else {
    rules = [];
    line = "No company rules yet";
  }
  return {
    company: companyName,
    chatId,
    messages,
    dates: dateLines(messages, loaded.timeZone, now, loaded.formats),
    drafts,
    working: messages.some((m) => m.status === "working" && !m.stale),
    applying: applyingNow,
    panel: { line, rules },
    chips: messages.length ? [] : CHIPS,
  };
}
