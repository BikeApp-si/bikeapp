import { and, eq, gt, inArray, or } from "drizzle-orm";
import { jobs, rows } from "@/db/schema";
import { plansIn, readChat, type Message } from "@/server/kernel/chats";
import { load, type KernelCtx } from "@/server/kernel/context";
import { planContext } from "@/server/kernel/plans/context";
import { canMove } from "@/server/kernel/plans/plan";
import { movesOf } from "@/server/kernel/customize/link-instead";
import { planMove } from "@/server/kernel/customize/move";
import { moveView, type MoveView } from "./move-view";
import { addedLines, renderCapabilityText, type TextSection } from "@/server/kernel/render-text";
import type { Tx } from "@/server/kernel/tx";
import { planNow } from "./import";
import type { ImportDraft, PlanDraft } from "./types";
import { currentTime } from "@/server/kernel/clock";
import { reportsIn } from "@/server/kernel/report/store";
import { reportView, type ReportView } from "@/server/kernel/report/view";
import { dateLines } from "@/server/kernel/chat-list";

// A chat as Home shows it (5b–5l): its messages, and each plan in it with what the reply, the card and the
// side panel need, worked out on the server. A reply still working reads as stopped once its job has ended
// without finishing it (the worker stopped), or after 10 minutes when it has no job.

export const STALE_MS = 10 * 60 * 1000;

export type PlanView = {
  id: string;
  version: number;
  latest: number; // the chat's newest plan version ("v2 of 2")
  status: "waiting" | "replaced" | "created";
  capabilityId: string | null;
  name: string;
  icon: string;
  rows: { one: string; many: string }; // what its first sheet's rows are called
  summary: string;
  lead: string;
  brief: string | null;
  leftOut: string | null;
  experience: PlanDraft["design"]["experience"];
  alsoChanges: { capability: string; change: string; reason: string }[];
  // Data moves Bike can't do yet, named only (5l). One it can (M27) is an Also change, with its preview in moves.
  restructures: { capability: string; change: string; reason: string }[];
  moves: MoveView[]; // what each data move does to today's rows, from the kernel; only while the plan waits
  rules: { when: string; then: string }[];
  rulesFrom: string | null;
  preview: string;
  import: ImportDraft | null;
  sections: TextSection[]; // the side panel, as plain text
};

export type ChatView = { id: string; kind: string; reports: Record<string, ReportView>; changed: Record<string, boolean>; messages: (Message & { stale: boolean })[]; dates: Record<string, string>; plans: Record<string, PlanView>; working: boolean };

export async function chatView(tx: Tx, ctx: KernelCtx, chatId: string, now = currentTime()): Promise<ChatView> {
  const { chat, messages } = await readChat(tx, ctx, chatId);
  // A build's plan (4b) is drawn from its reply's parts; only capability plans have a card and panel. A Customize
  // change or a company rule has neither here: those chats open in their own place (chatPlace, #12).
  const stored = (await plansIn(tx, ctx, chatId)).filter((p) => (p.draft as { kind?: string }).kind === undefined);
  const latest = Math.max(0, ...stored.map((p) => p.version));
  const pc = stored.length ? await planContext(tx, ctx) : null;
  const loaded = stored.length ? await load(tx) : null;
  const plans: Record<string, PlanView> = {};
  for (const p of stored) {
    const draft = p.draft as PlanDraft;
    const d = draft.design;
    const checked = planNow(draft, pc!);
    const files = new Map([...pc!.files, ...[...checked.edited].map(([id, e]) => [id, e.after] as const), [draft.newId, checked.file]]);
    const personName = (id: string) => loaded!.people.get(id)?.name;
    const added = [...checked.edited.values()].flatMap((e) => addedLines(e.before, e.after, personName));
    const moves = p.status === "waiting" && !checked.problems.length
      ? await Promise.all([...checked.edited].flatMap(([id, e]) => movesOf(id, e.before, e.after)).map(async (m) => moveView(await planMove(tx, { before: pc!.files, after: files }, m))))
      : [];
    plans[p.id] = {
      id: p.id,
      version: p.version,
      latest,
      status: p.status,
      capabilityId: p.capabilityId,
      name: d.capability!.name,
      icon: d.capability!.icon,
      rows: checked.file.sheets[0]?.row ?? { one: "row", many: "rows" },
      summary: draft.summary,
      lead: d.lead,
      brief: d.brief,
      leftOut: d.left_out,
      experience: d.experience,
      alsoChanges: d.also_changes.filter((a) => a.kind === "add" || canMove(a)).map((a) => ({ capability: a.sheet ? `${a.capability} › ${a.sheet}` : a.capability, change: a.change, reason: a.reason })),
      restructures: d.also_changes.filter((a) => a.kind === "restructure" && !canMove(a)).map((a) => ({ capability: a.capability, change: a.change, reason: a.reason })),
      moves,
      rules: draft.rules.map((r) => ({ when: r.when, then: r.then })),
      rulesFrom: d.rules_from,
      preview: draft.preview,
      import: draft.import ?? null,
      sections: renderCapabilityText(checked.file, { capId: draft.newId, files, personName, viewerId: ctx.actor.id, formats: loaded!.formats }, { alsoChanges: added, suggested: d.suggested_connections }),
    };
  }
  const working = messages.filter((m) => m.status === "working").map((m) => m.id);
  // A reply can have several jobs (Build all, then the answer to its one question, Nov 9): it has stopped only
  // when none of them is still queued or running, whatever order the rows come in.
  const jobsOf = new Map<string, string[]>();
  if (working.length) for (const j of await tx.select({ messageId: jobs.messageId, status: jobs.status }).from(jobs).where(inArray(jobs.messageId, working))) jobsOf.set(j.messageId!, [...(jobsOf.get(j.messageId!) ?? []), j.status]);
  const stale = (m: Message) => {
    if (m.status !== "working") return false;
    const its = jobsOf.get(m.id);
    return its ? its.every((s) => s === "done" || s === "failed") : now.getTime() - m.at.getTime() > STALE_MS;
  };
  const shown = messages.map((m) => ({ ...m, stale: stale(m) }));
  // A report chat's runs, as the reply and the panel draw them (11c–12d).
  const reports: Record<string, ReportView> = {};
  const changed: Record<string, boolean> = {};
  if (chat.kind === "report") {
    const runs = await reportsIn(tx, ctx, chatId);
    const loadedNow = await load(tx);
    const words = (sheet: string) => [...loadedNow.files.values()].flatMap((f) => f.file.sheets).find((s) => s.name === sheet)?.row ?? { one: "row", many: "rows" };
    for (const r of runs) {
      reports[r.id] = reportView(r, words, loadedNow.timeZone, r.firstId ? runs.find((x) => x.id === r.firstId) : undefined, loadedNow.formats);
      // 12c: whether anything in the sheets it read was written or changed after it ran.
      const sheets = r.result.sources.flatMap((s) => {
        const cap = [...loadedNow.files.values()].find((f) => f.file.name === s.capability);
        const sheet = cap?.file.sheets.find((x) => x.name === s.sheet);
        return cap && sheet ? [and(eq(rows.capabilityId, cap.id), eq(rows.sheetId, sheet.id))] : [];
      });
      const [newer] = sheets.length ? await tx.select({ id: rows.id }).from(rows).where(and(or(...sheets), gt(rows.updatedAt, r.ranAt))).limit(1) : [];
      changed[r.id] = !!newer;
    }
  }
  const loadedNow = await load(tx);
  const dates = dateLines(shown, loadedNow.timeZone, now, loadedNow.formats);
  return { id: chatId, kind: chat.kind, reports, changed, messages: shown, dates, plans, working: shown.some((m) => m.status === "working" && !m.stale) };
}
