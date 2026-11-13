import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { dayIn, formatDay, US, type Formats } from "@/lib/format";
import { chats, messages, plans } from "@/db/schema";
import { mustBeAdmin } from "./admin";
import { load, todayIn, type KernelCtx } from "./context";
import { currentTime } from "./clock";
import type { Tx } from "./tx";
import type { CustomizeDraft, PlanDraft } from "@/server/chat/types";
import { chatHome } from "./chats";

// The admin's own chats (12a, 12b): newest first, what each did, the capabilities it touched, and when the
// last message came. RLS shows only the admin's own; nobody else's chats are ever listed.

// href: where it opens (#12). did: "Report"; line (12a): what it did with a word more, "New capability · 3 changes in Spend and Tools and budgets".
export type ChatRow = { id: string; href: string; title: string; did: string; line: string; capabilities: string[]; at: Date; when: string; day: string };

const both = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57).trimEnd()}…` : s);

// only: just these chats (a search's matches).
export async function listChats(tx: Tx, ctx: KernelCtx, opts: { limit?: number; only?: string[] } = {}): Promise<ChatRow[]> {
  await mustBeAdmin(tx, ctx);
  if (opts.only && !opts.only.length) return [];
  const q = tx.select().from(chats).where(and(eq(chats.authorId, ctx.actor.id), opts.only ? inArray(chats.id, opts.only) : undefined)).orderBy(desc(chats.updatedAt)).$dynamic();
  const list = await (opts.limit ? q.limit(opts.limit) : q);
  if (!list.length) return [];
  const ids = list.map((c) => c.id);
  // The last plan each chat applied: a new capability with its Also changes, or a Customize change set.
  const created = new Map<string, PlanDraft | CustomizeDraft>();
  for (const p of await tx.select({ chatId: plans.chatId, draft: plans.draft }).from(plans).where(and(inArray(plans.chatId, ids), eq(plans.status, "created"))).orderBy(asc(plans.createdAt)))
    created.set(p.chatId, p.draft as PlanDraft | CustomizeDraft);
  const firsts = new Map<string, string>();
  for (const m of await tx.select({ chatId: messages.chatId, text: messages.text, from: messages.from }).from(messages).where(inArray(messages.chatId, ids)).orderBy(asc(messages.seq)))
    if (m.from === "person" && m.text && !firsts.has(m.chatId)) firsts.set(m.chatId, m.text);
  const loaded = await load(tx);
  const names = (capIds: string[]) => capIds.map((id) => loaded.files.get(id)?.file.name).filter((n): n is string => !!n);
  const today = todayIn(loaded.timeZone, ctx.now ?? currentTime());
  return list.map((c) => {
    const caps = names(c.capabilityIds as string[]);
    const did =
      c.kind === "report" ? "Report"
      : c.kind === "customize" ? "Customized"
      : c.kind === "company" ? "Company rules"
      : c.kind === "build" ? `${caps.length} new ${caps.length === 1 ? "app" : "apps"}`
      : created.has(c.id) ? "New app"
      : "Plan";
    const plan = created.get(c.id);
    const also = plan && !("kind" in plan) ? plan.design.also_changes.length : 0;
    const more =
      c.kind === "report" ? caps.join(", ")
      : plan && "kind" in plan ? `${plan.capability} version ${plan.version}`
      : also ? `${also} ${also === 1 ? "change" : "changes"} in ${both(caps.slice(1))}`
      : c.kind === "build" ? caps.join(", ")
      : "";
    const t = stamp(c.updatedAt, loaded.timeZone, today, loaded.formats);
    const href = chatHome(c, (id) => loaded.files.has(id)) ?? `/home?chat=${c.id}`;
    return { id: c.id, href, title: c.title ?? short(firsts.get(c.id) ?? "A chat"), did, line: more ? `${did} · ${more}` : did, capabilities: caps, at: c.updatedAt, when: t.when, day: t.day };
  });
}

// A search's words as a full-text query: each word, the last one also as the start of a word ("engin" finds
// Engineering). Only letters and digits are kept, so nothing typed is read as query syntax.
export function searchQuery(text: string): string | null {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? [];
  if (!words.length) return null;
  return words.map((w, i) => (i === words.length - 1 ? `${w}:*` : w)).join(" & ");
}

export type Match = { text: string; bold: boolean }[];
export type FoundChat = ChatRow & { match: Match | null };

const START = "\u0001";
const STOP = "\u0002";

// The line that matched with the found words marked: "…and **Engineering** 82%, with two months to go."
function asMatch(headline: string): Match {
  const out: Match = [];
  for (const [i, part] of headline.replace(/\*\*/g, "").split(new RegExp(`[${START}${STOP}]`)).entries()) if (part) out.push({ text: part, bold: i % 2 === 1 });
  return out;
}

// m33-f: full-text over the titles and messages of the admin's own chats, newest first; for each, the latest message
// that matched, with the words marked. Another admin's chats are never searched (RLS, and the author check here).
export async function searchChats(tx: Tx, ctx: KernelCtx, text: string): Promise<FoundChat[]> {
  await mustBeAdmin(tx, ctx);
  const q = searchQuery(text);
  if (!q) return [];
  const found = await tx.execute<{ id: string; line: string | null }>(sql`
    select c.id, (
      select ts_headline('english', m.text, to_tsquery('english', ${q}), ${`StartSel=${START}, StopSel=${STOP}, MaxWords=22, MinWords=10, MaxFragments=1, FragmentDelimiter=" … "`})
      from messages m where m.chat_id = c.id and m.search @@ to_tsquery('english', ${q}) order by m.seq desc limit 1
    ) as line
    from chats c
    where c.author_id = ${ctx.actor.id}
      and (c.search @@ to_tsquery('english', ${q}) or exists (select 1 from messages m where m.chat_id = c.id and m.search @@ to_tsquery('english', ${q})))`);
  const lines = new Map([...found].map((f) => [f.id, f.line]));
  const rows = await listChats(tx, ctx, { only: [...lines.keys()] });
  return rows.map((r) => {
    const line = lines.get(r.id);
    return { ...r, match: line ? asMatch(line) : null };
  });
}

// "Today, 10:02" or "Oct 23, 16:40" (when), and "10:02" or "Oct 23" (day), in the workspace's time zone.
export function stamp(at: Date, timeZone: string, today: string, fmt: Formats = US): { when: string; day: string } {
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  const date = formatDay(dayIn(at, timeZone), fmt);
  return todayIn(timeZone, at) === today ? { when: `Today, ${time}`, day: time } : { when: `${date}, ${time}`, day: date };
}

// The date lines inside a chat (12c, 12e): above the first message of each day, once a chat is not all from
// today. Keyed by the message they stand above.
export function dateLines(list: { id: string; at: Date }[], timeZone: string, now: Date, fmt: Formats = US): Record<string, string> {
  const today = todayIn(timeZone, now);
  if (list.every((m) => todayIn(timeZone, m.at) === today)) return {};
  const out: Record<string, string> = {};
  let last = "";
  for (const m of list) {
    const day = todayIn(timeZone, m.at);
    if (day !== last) out[m.id] = stamp(m.at, timeZone, today, fmt).when;
    last = day;
  }
  return out;
}
