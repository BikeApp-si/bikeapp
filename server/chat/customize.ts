import { moveView } from "./move-view";
import type { MovePlan } from "@/server/kernel/customize/move";
import { mustCustomize } from "@/server/kernel/capabilities";
import { and, eq } from "drizzle-orm";
import { people, rows, workspaces } from "@/db/schema";
import { AiError, ask, BuildRefused, TRY_AGAIN } from "@/server/ai/gateway";
import { customizePlanner, type CustomizeInput, type CustomizeOutput } from "@/server/ai/prompts/customize-planner@12";
import { customizeRouter } from "@/server/ai/prompts/customize-router@3";
import { capabilityProfile } from "@/server/kernel/profile";
import { adviceAnswer } from "./customize-advice";
import { accessSummary } from "@/server/kernel/access-summary";
import { guideAnswer } from "./customize-guide";
import { customizeSuggestions } from "@/server/ai/prompts/customize-suggestions@2";
import { logicWriter } from "@/server/ai/prompts/logic-writer@7";
import { addMessage, customizeChatFor, getPlan, markCreated, readChat, renameChat, saveDraft, startChat, touchChat, updateMessage, type Part } from "@/server/kernel/chats";
import { KernelError, load, workspaceFormats, type KernelCtx } from "@/server/kernel/context";
import { formatDay } from "@/lib/format";
import { applyCustomize, customizeProblems, previewCustomize, type Edits } from "@/server/kernel/customize/apply";
import { compileCustomize, ruleChanges, tryEdits, type Compiled, type CustomizeWorld } from "@/server/kernel/customize/compile";
import { customizeDescription } from "@/server/kernel/customize/context";
import { impactText } from "@/server/kernel/customize/impact";
import { keepSuggestions, saveSuggestions } from "@/server/kernel/customize/suggestions";
import { refusal } from "@/server/kernel/customize/words";
import { describeCapability } from "@/server/kernel/plans/structure";
import { previewRepeatRule, previewRule } from "@/server/kernel/preview";
import { isRepeat } from "@/server/kernel/repeats";
import { renderCapabilityText } from "@/server/kernel/render-text";
import type { CapabilityFile, Rule } from "@/server/kernel/schema/file";
import { LIMITS } from "@/server/kernel/schema/validate";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import type { CustomizeDraft } from "./types";

// A capability's Customize chat (6b–6l). A message becomes a preview: prompt 3's changes, compiled and checked
// by the kernel, prompt 4 for its rules, then what it does to today's rows and the text as it will read. Apply
// runs the change set with a Part / Status reply (6d, 6i). Nothing is live until the admin clicks Apply.
// C2: a typed message first goes to the router (prompt 9): a change goes to the planner, a question to the guide
// (prompt 10), which explains and changes nothing; a word or two gets "Do it" or "Explain first". A message from a
// button already says where it goes. Every refusal becomes a guide answer: why, and requests that work.

type Person = { id: string; email: string };
type SetRule = { kind: "set_rule"; rule: Rule };
export type Work = () => Promise<void>;
// Where a message goes: typed (the router decides), or from a button: plan (a choice or a suggested request), explain,
// and the two answers to "Do it or explain first?", which act on the message before.
export const VIAS = ["typed", "plan", "explain", "do_it", "explain_first"] as const;
export type Via = (typeof VIAS)[number];
type Job = { workspaceId: string; person: Person; chatId: string; replyId: string; capabilityId: string };

const plural = (n: number, w: { one: string; many: string }) => `${n} ${n === 1 ? w.one : w.many}`;
const and_ = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? ""));

// A message in the Customize chat: the admin's message is written now, the work runs after the response.
export async function sendCustomize(tx: Tx, ctx: KernelCtx, capabilityId: string, text: string, via: Via = "typed"): Promise<{ chatId: string; work: Work }> {
  if (!VIAS.includes(via)) throw new KernelError("That can't be sent here.");
  if (!text.trim()) throw new KernelError("Type a message first.");
  await mustCustomize(tx, ctx, capabilityId);
  const cap = (await load(tx)).files.get(capabilityId);
  if (!cap) throw new KernelError("That app doesn't exist.");
  let chatId = await customizeChatFor(tx, ctx, capabilityId);
  if (chatId) await addMessage(tx, ctx, chatId, { from: "person", text: text.trim() });
  else {
    chatId = (await startChat(tx, ctx, "customize", { text: text.trim() })).chatId;
    await touchChat(tx, ctx, chatId, { title: `Customize ${cap.file.name}`, capabilityIds: [capabilityId] });
  }
  const replyId = await addMessage(tx, ctx, chatId, { from: "bike", text: "", status: "working" });
  const job = { workspaceId: ctx.workspaceId, person: ctx.actor as Person, chatId, replyId, capabilityId };
  return { chatId, work: () => runCustomize(job, text.trim(), via) };
}

// The capabilities this one connects to: those its file names, and those whose files name it.
function connectedTo(capId: string, files: ReadonlyMap<string, CapabilityFile>): string[] {
  const mine = JSON.stringify(files.get(capId));
  return [...files].filter(([id, f]) => id !== capId && (mine.includes(id) || JSON.stringify(f).includes(capId))).map(([id]) => id);
}

// Every capability it isn't connected to, by name: its sheets and what names their rows, so a typed column can be
// linked to one (M27). Sorted by name, so the request is the same every time.
function otherCapabilities(capId: string, files: ReadonlyMap<string, CapabilityFile>) {
  const near = new Set([capId, ...connectedTo(capId, files)]);
  return [...files]
    .filter(([id]) => !near.has(id))
    .map(([, f]) => ({ name: f.name, sheets: f.sheets.filter((s) => s.kind !== "lines").map((s) => ({ name: s.name, named_by: s.columns.find((c) => c.id === s.titleColumn)?.name ?? "" })) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const UNSURE = "Should I change it, or explain first?";

export async function runCustomize(job: Job, typed: string, via: Via = "typed"): Promise<void> {
  const ctx: KernelCtx = { workspaceId: job.workspaceId, actor: job.person };
  const k = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: job.workspaceId, personId: job.person.id }, (tx) => fn(tx, ctx));
  const who = { workspaceId: job.workspaceId, personId: job.person.id, chatId: job.chatId, capabilityId: job.capabilityId };
  const finish = (m: { text: string; parts?: Part[]; status?: "done" | "failed" }) => k((tx, c) => updateMessage(tx, c, job.replyId, { text: m.text, parts: m.parts ?? [], status: m.status ?? "done" }));

  try {
    const { files, peopleList, personName, company, user, emails, formats } = await k(async (tx) => {
      const loaded = await load(tx);
      const all = await tx.select({ id: people.id, name: people.name, email: people.email, title: people.title }).from(people).orderBy(people.name);
      const [ws] = await tx.select({ name: workspaces.name, timeZone: workspaces.timeZone, currency: workspaces.currency }).from(workspaces);
      const me = all.find((p) => p.id === job.person.id)!;
      return {
        files: new Map([...loaded.files].map(([id, f]) => [id, f.file] as const)),
        peopleList: all,
        personName: (id: string) => loaded.people.get(id)?.name,
        company: { name: ws!.name, timeZone: ws!.timeZone, currency: ws!.currency ?? "USD" },
        user: { name: me.name, email: me.email },
        emails: new Map(all.map((p) => [p.email.toLowerCase(), p.id])),
        formats: loaded.formats,
      };
    });
    const file = files.get(job.capabilityId)!;
    const w: CustomizeWorld = { capId: job.capabilityId, files, people: emails };
    const { messages } = await k((tx, c) => readChat(tx, c, job.chatId));
    const conversation = messages
      .slice(0, -2)
      .filter((m) => m.status === "done")
      .map((m) => ({ from: m.from, text: m.text || m.parts.flatMap((p) => (p.kind === "text" ? [p.text] : [])).join(" ") || (m.parts.some((p) => p.kind === "change") ? "(sent a preview)" : "") }))
      .filter((m) => m.text);
    const sections = renderCapabilityText(file, { capId: job.capabilityId, files, personName, viewerId: null, formats });
    const text0 = sections.map((s) => [s.heading, ...s.lines].join("\n")).join("\n\n");
    // "Do it" and "Explain first" act on the admin's message before the question.
    const earlier = messages.slice(0, -2).filter((m) => m.from === "person");
    const text = via === "do_it" || via === "explain_first" ? (earlier.at(-1)?.text ?? typed) : typed;
    const lastBike = messages.slice(0, -2).findLast((m) => m.from === "bike");
    const refusedLast = !!lastBike && (lastBike.parts.some((p) => p.kind === "guide" && p.refusal) || lastBike.text.startsWith("I can't apply that."));
    const routed = async (): Promise<"change" | "explain" | "advise" | "unsure"> => {
      try {
        return (await ask(customizeRouter, { capability: file.name, conversation: conversation.slice(-4), refused: refusedLast, message: text }, who, { building: false })).way;
      } catch (e) {
        if (!(e instanceof AiError)) throw e;
        return "change"; // as before the router: the planner answers questions too
      }
    };
    const way = via === "typed" ? await routed() : via === "plan" || via === "do_it" ? "change" : "explain";
    if (way === "unsure") return void (await finish({ text: UNSURE, parts: [{ kind: "buttons", buttons: [{ action: "do_it", label: "Do it" }, { action: "explain_first", label: "Explain first" }] }] }));

    const input: CustomizeInput = {
      user,
      company,
      capability: customizeDescription(job.capabilityId, files, personName, { withForm: true, withAccess: true }),
      text: text0,
      connected: connectedTo(job.capabilityId, files).map((id) => describeCapability(id, files, personName)),
      others: otherCapabilities(job.capabilityId, files),
      people: peopleList.map((p) => ({ name: p.name, email: p.email, title: p.title })),
      conversation,
      request: text,
    };
    // Each answer is checked by the kernel as Apply would check it (C1), so the AI's one retry fixes what the
    // kernel finds, and a question's choices are offered only when each one would apply.
    let compiled: Compiled | null = null;
    let kernelSaid: string[] = [];
    const kernelProblems = async (changes: CustomizeOutput["changes"]): Promise<string[]> => {
      const c = compileCustomize(changes, w);
      // With rule sentences, the logic writer writes the rules next and its check sees the whole change set.
      if (c.problems.length || c.rules.length) return c.problems;
      const t = tryEdits(w, c.changes, c);
      return t.edits ? k((tx) => customizeProblems(tx, t.edits)) : t.problems;
    };
    // A guide answer: it explains and changes nothing; its suggestions are checked like a question's choices.
    const guide = async (refused?: string) =>
      guideAnswer(
        {
          sections,
          capability: input.capability,
          access: await k((tx, c) => accessSummary(tx, c, job.capabilityId)),
          conversation: conversation.slice(-6),
          message: text,
          ...(refused ? { refusal: refused.replace(/^I can't apply that\. /, "") } : {}),
        },
        who,
        kernelProblems,
      );
    // Advice (C3), on the large model; if it fails, the guide answers, and failing that a plain answer.
    if (way === "advise") {
      try {
        const counts = await k((tx, c) => capabilityProfile(tx, c, job.capabilityId));
        // By name: the order capabilities load in follows their ids, which differ between runs.
        const others = [...files].filter(([id]) => id !== job.capabilityId).map(([, f]) => f.name).sort((a, b) => a.localeCompare(b));
        const room = Math.max(0, LIMITS.sheets - file.sheets.length);
        return void (await finish(await adviceAnswer({ text: text0, capability: input.capability, counts, others, room, conversation: conversation.slice(-6), message: text }, who, kernelProblems)));
      } catch (e) {
        if (!(e instanceof AiError)) throw e;
      }
    }
    if (way === "explain" || way === "advise") {
      try {
        return void (await finish(await guide()));
      } catch (e) {
        if (!(e instanceof AiError)) throw e;
        // Never only "I couldn't do that" to a question: what Bike knows about the capability, plainly.
        return void (await finish(plainAnswer(file)));
      }
    }
    // A change Bike can't make is taught: why, and requests that work. Without the guide, the plain refusal stays.
    const teach = async (reason: string): Promise<boolean> => {
      try {
        await finish(await guide(reason));
        return true;
      } catch (e) {
        if (!(e instanceof AiError)) throw e;
        return false;
      }
    };
    const check = async (o: CustomizeOutput): Promise<string[]> => {
      kernelSaid = [];
      if (o.type === "clarify") {
        if (!o.clarify) return ["A question needs its choices."];
        const out: string[] = [];
        for (const opt of o.clarify.options) for (const p of await kernelProblems(opt.changes)) out.push(`The choice “${opt.label}” wouldn't apply: ${p}`);
        return out;
      }
      if (o.type !== "change") return [];
      if (!o.changes.length) return ["A change needs at least one change."];
      // The chat is named by it once applied (12b), so it stays short. The prompt asks for two to four words; a
      // fifth or sixth is let through (M25: a two-part change, "Legal review and earlier reminder", came back at
      // five words even when the retry named it), so a valid change isn't refused over its name.
      const words = o.title?.trim().split(/\s+/).length ?? 0;
      if (words < 2 || words > 6)
        return [
          o.title?.trim()
            ? `title: “${o.title.trim()}” is ${words} ${words === 1 ? "word" : "words"}; it must be two to four, naming the main thing it adds or changes (“Legal review step”, “Earlier renewal reminders”), even when there are several changes.`
            : "title: two to four words naming what it adds or changes.",
        ];
      compiled = compileCustomize(o.changes, w);
      kernelSaid = await kernelProblems(o.changes);
      return kernelSaid;
    };
    // Bike's replies so far, to never give the same refusal twice.
    const said = new Set(messages.filter((m) => m.from === "bike").map((m) => m.text.trim()));
    const planned = async (refused?: string): Promise<CustomizeOutput> => {
      try {
        return await ask(customizePlanner, refused ? { ...input, refused } : input, who, { check });
      } catch (e) {
        // The retry still failed the kernel: say why, in plain words.
        if (e instanceof AiError && kernelSaid.length) throw new AiError(refusal(kernelSaid));
        throw e;
      }
    };
    // A refusal Bike already gave becomes one question with choices that apply; failing that, a new sentence.
    const notAgain = async (said_: string): Promise<CustomizeOutput | string> => {
      if (!said.has(said_.trim())) return said_;
      try {
        return await planned(said_);
      } catch (e) {
        if (!(e instanceof AiError)) throw e;
        return `${said_} Say what you'd like in its place, in other words, and I'll try that.`;
      }
    };

    let out: CustomizeOutput;
    try {
      out = await planned();
    } catch (e) {
      if (!(e instanceof AiError) || e.message === TRY_AGAIN || e instanceof BuildRefused) throw e;
      if (await teach(e.message)) return;
      const next = await notAgain(e.message);
      if (typeof next === "string") return void (await finish({ text: next }));
      out = next;
    }
    if (out.type === "refuse") {
      if (await teach(out.reply)) return;
      const next = await notAgain(out.reply);
      if (typeof next === "string") return void (await finish({ text: next }));
      out = next;
    }
    if (out.type !== "change" || !compiled) return void (await finish(notAChange(out, job.capabilityId, file)));
    const c: Compiled = compiled;

    // Prompt 4 writes the rules, against the capability as the other changes leave it.
    let rules: SetRule[] = [];
    if (c.rules.length) {
      const shaped = new Map(files);
      const before = tryEdits(w, c.changes, c);
      if (!before.edits) {
        if (await teach(refusal(before.problems))) return;
        return void (await finish({ text: refusal(before.problems) }));
      }
      shaped.set(job.capabilityId, before.edits.get(job.capabilityId)!.after);
      const written = await ask(
        logicWriter,
        {
          company: { name: company.name, timeZone: company.timeZone },
          capabilities: [job.capabilityId, ...connectedTo(job.capabilityId, files)].map((id) => describeCapability(id, shaped, personName)),
          people: peopleList.map((p) => ({ name: p.name, email: p.email, title: p.title })),
          sentences: c.rules.map((r) => r.sentence),
        },
        who,
        {
          check: (o) => {
            const r = ruleChanges(c, o.rules, w);
            if (r.problems.length) return r.problems;
            const t = tryEdits(w, [...c.changes, ...r.changes], c);
            return t.edits ? k((tx) => customizeProblems(tx, t.edits)) : t.problems;
          },
        },
      );
      rules = ruleChanges(c, written.rules, w).changes;
      if (written.could_not.length && !rules.length) return void (await finish({ text: written.could_not.map((x) => x.reason).join(" ") }));
    }

    const made = tryEdits(w, [...c.changes, ...rules], c);
    if (!made.edits) {
      if (await teach(refusal(made.problems))) return;
      return void (await finish({ text: refusal(made.problems) }));
    }
    const edits = made.edits;
    const preview = await k((tx, cx) => previewCustomize(tx, cx, job.capabilityId, edits, job.chatId));
    // A change the kernel refuses (a step with rows can't be removed, a loop) is said as it is; nothing to apply.
    if (preview.problems.length) {
      if (await teach(refusal(preview.problems))) return;
      return void (await finish({ text: refusal(preview.problems) }));
    }

    const draft = await draftOf(k, job, out, c, rules, edits, preview.version, impactText(preview.impact!), preview.moves);
    const plan = await k((tx, cx) => saveDraft(tx, cx, job.chatId, job.replyId, draft));
    await finish({ text: "", parts: [{ kind: "change", planId: plan.id }] });
  } catch (e) {
    if (!(e instanceof AiError) && !(e instanceof KernelError)) console.error(e);
    await finish({ text: e instanceof AiError || e instanceof KernelError ? e.message : TRY_AGAIN, status: "failed" });
  }
}

// When the guide can't answer: what the capability has and what can be asked, from the kernel alone (no AI).
export function plainAnswer(file: CapabilityFile): { text: string; parts: Part[] } {
  const sheets = file.sheets.filter((s) => s.kind !== "lines").map((s) => s.name);
  const room = LIMITS.sheets - file.sheets.length;
  return {
    text: [
      `I couldn't put a full answer together this time. ${file.name} has ${sheets.length === 1 ? "one sheet" : `${sheets.length} sheets`}, ${and_(sheets)}${room > 0 ? `, and room for ${room === 1 ? "one more" : `${room} more`}` : ", the most an app can have"}.`,
      "Ask me for a change in your own words, such as a new sheet, a question, a step, a rule, or who can see what, and I'll show it before anything changes. Or ask again, more specifically.",
    ].join("\n\n"),
    parts: [{ kind: "guide", section: null }],
  };
}

// A question with choices (6l), rows that are changed in the Data tab (6k), or what 0.1 can't do.
function notAChange(out: CustomizeOutput, capId: string, file: CapabilityFile): { text: string; parts: Part[] } {
  if (out.type === "clarify" && out.clarify)
    return {
      text: out.reply,
      // Each choice was checked by the kernel; pressed, it goes straight to the planner.
      parts: [{ kind: "buttons", buttons: out.clarify.options.map((o) => ({ action: "plan", label: o.label })) }, ...(out.clarify.hint ? [{ kind: "text" as const, text: out.clarify.hint, muted: true }] : [])],
    };
  if (out.type === "data_task") return { text: out.reply, parts: [{ kind: "link", label: `Open ${file.sheets[0]!.name}`, href: `/c/${capId}` }] };
  return { text: out.reply, parts: [] };
}

async function draftOf(
  k: <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => Promise<T>,
  job: Job,
  out: CustomizeOutput,
  c: Compiled,
  rules: SetRule[],
  edits: Edits,
  version: number,
  impact: string,
  moved: MovePlan[] = [],
): Promise<CustomizeDraft> {
  const main = edits.get(job.capabilityId)!;
  const capName = main.before.name;
  const renames = await k(async (tx) => {
    const out = [];
    for (const r of c.renames) {
      if (!r.stepId) continue;
      const sheet = main.before.sheets.find((s) => s.id === r.sheetId)!;
      const stepCol = sheet.columns.find((x) => x.type === "step")!;
      const live = await tx.select({ data: rows.data, deletedAt: rows.deletedAt }).from(rows).where(and(eq(rows.capabilityId, job.capabilityId), eq(rows.sheetId, sheet.id)));
      const count = live.filter((x) => !x.deletedAt && (x.data as Record<string, unknown>)[stepCol.id] === r.stepId).length;
      const reworded = (u: (typeof r.uses)[number]) =>
        (u.ruleId && [...edits.values()].flatMap((e) => e.after.rules).find((x) => x.id === u.ruleId)?.text) || u.text;
      out.push({ from: r.from, to: r.to, count, rows: sheet.row ?? { one: "row", many: "rows" }, insteadOfRemoval: r.insteadOfRemoval, uses: r.uses.map((u) => ({ kind: u.kind, text: reworded(u) })) });
    }
    return out;
  });

  // A single new rule (6f) reads as When / Then with what it would have done.
  const onlyRule = !c.changes.length && rules.length === 1 && !c.rules[0]!.replaces ? rules[0]!.rule : null;
  let rule: CustomizeDraft["rule"] = null;
  if (onlyRule) {
    const sheet = main.after.sheets.find((s) => s.id === onlyRule.trigger.sheet)!;
    // A repeating rule's past dates have no rows to list; its own preview below names them.
    const p = isRepeat(onlyRule) ? null : await k((tx, cx) => previewRule(tx, cx, job.capabilityId, onlyRule).catch(() => null));
    const a = onlyRule.actions.find((x) => x.kind === "notify" || x.kind === "ask_person");
    const personCol = a?.kind === "notify" ? a.columns?.[0] : a?.kind === "ask_person" ? a.column : undefined;
    const title = sheet.columns.find((x) => x.id === sheet.titleColumn)!;
    const person = sheet.columns.find((x) => x.id === personCol);
    const fmt = await k((tx) => workspaceFormats(tx));
    const day = (d: string) => formatDay(d, fmt);
    const tableRows = await k(async (tx) => {
      const names = new Map((await tx.select({ id: people.id, name: people.name }).from(people)).map((x) => [x.id, x.name]));
      const list = [];
      for (const item of p?.items ?? []) {
        const [r] = await tx.select({ data: rows.data }).from(rows).where(eq(rows.id, item.rowId));
        const v = person ? (r?.data as Record<string, unknown>)[person.id] : undefined;
        list.push([item.title, ...(person ? [names.get(String(v)) ?? ""] : []), day(item.on)]);
      }
      return list;
    });
    const repeat = isRepeat(onlyRule) ? await k((tx, cx) => previewRepeatRule(tx, cx, job.capabilityId, onlyRule).catch(() => null)) : null;
    rule = {
      // A repeating rule's When is the kernel's own words for its schedule ("Every month on the 1st, from Nov 8, 2026").
      when: repeat?.schedule ?? onlyRule.reading.when,
      then: onlyRule.reading.then,
      daily: onlyRule.trigger.kind === "date_reached" || !!repeat,
      ...(repeat ? { repeats: { next: repeat.next, columns: repeat.columns, values: repeat.values, past: repeat.past, pastWords: repeat.pastWords } } : {}),
      rows: sheet.row ?? { one: "row", many: "rows" },
      // The first column is named for the row ("Contract"), as 6f shows it.
      preview: { columns: [sheet.row ? cap(sheet.row.one) : title.name, ...(person ? [person.name] : []), "Would have run"], rows: tableRows },
    };
  }

  const fixes = renames.flatMap((r) => r.uses.filter((u) => u.kind !== "total"));
  const n = c.words.length;
  // A data move (M27): Apply says how many rows it links; one that can't map any row has no Apply.
  const moves = moved.map(moveView);
  const linking = moves.find((m) => m.button)?.button;
  const button = onlyRule ? "Add this rule" : fixes.length ? "Apply with these fixes" : linking ?? (n === 1 ? "Apply" : `Apply ${n} changes`);
  const connections = fixes.filter((u) => u.kind === "connection").length;
  const ruleCount = fixes.length - connections;
  const tail = fixes.length
    ? `${and_([connections ? plural(connections, { one: "connection", many: "connections" }) : "", ruleCount ? plural(ruleCount, { one: "rule", many: "rules" }) : ""].filter(Boolean))} moved to ${renames[0]!.to}`
    : onlyRule
      ? "1 rule"
      : moved.some((m) => m.cantMap.length)
        ? "nothing can move yet"
        : plural(n, { one: "change", many: "changes" });
  return {
    kind: "customize",
    capabilityId: job.capabilityId,
    capability: capName,
    version,
    edits: [...edits],
    reply: out.reply,
    title: out.title,
    changes: c.words,
    renames,
    impact,
    rule,
    button,
    collapsed: { lead: out.reply.split(/[.:]/)[0]!.trim(), tail },
    ...(moves.length ? { moves, moveParts: moved.map((m) => `Link ${plural(m.linked.length, { one: m.rowOne, many: m.rowMany })} to ${m.target}`) } : {}),
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// --- Apply (6d–6e, 6i–6j) ------------------------------------------------------------------------------------

export async function applyFromChat(tx: Tx, ctx: KernelCtx, chatId: string, planId: string): Promise<{ work: Work }> {
  const plan = await getPlan(tx, ctx, planId);
  if (plan.chatId !== chatId || plan.status !== "waiting") throw new KernelError("That preview has been replaced or applied.");
  const draft = plan.draft as CustomizeDraft;
  await mustCustomize(tx, ctx, draft.capabilityId);
  // A data move with rows it can't map has no Apply (m27-b); the kernel would refuse it too.
  if (draft.moves?.some((m) => !m.ok)) throw new KernelError("Some rows can't be linked yet, so nothing can move. Send your message again once they can.");
  await addMessage(tx, ctx, chatId, { from: "person", text: draft.button });
  const replyId = await addMessage(tx, ctx, chatId, { from: "bike", text: "", status: "working" });
  return { work: () => runApply({ workspaceId: ctx.workspaceId, person: ctx.actor as Person, chatId, replyId, capabilityId: draft.capabilityId }, planId) };
}

export const CHECK_PART = "Check every connection still points at something";
export const NOTHING_YET = "Nothing changes for anyone until every part is done.";

// The Part / Status rows: each change, each rename's rows, each rule it moved, then the connection check.
export function applyParts(d: CustomizeDraft): string[] {
  return [
    ...d.changes.map((x) => x.part),
    ...(d.moveParts ?? []),
    ...d.renames.flatMap((r) => [
      ...(r.count ? [`The ${plural(r.count, r.rows)} at ${r.from} are now at ${r.to}`] : []),
      ...r.uses.filter((u) => u.kind !== "total").map((u) => `${u.kind === "connection" ? "Connection" : "Rule"}: ${u.text.replace(/\.$/, "")}`),
    ]),
    CHECK_PART,
  ];
}

export async function runApply(job: Job, planId: string): Promise<void> {
  const ctx: KernelCtx = { workspaceId: job.workspaceId, actor: job.person };
  const k = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: job.workspaceId, personId: job.person.id }, (tx) => fn(tx, ctx));
  let rows: { label: string; state: "done" | "doing" | "next" | "failed" }[] = [];
  let text = "";
  const show = (extra: Part[] = [], status?: "done" | "failed") => k((tx, c) => updateMessage(tx, c, job.replyId, { text, parts: [{ kind: "status", head: "Part", rows, note: NOTHING_YET }, ...extra], ...(status ? { status } : {}) }));
  try {
    const plan = await k((tx, c) => getPlan(tx, c, planId));
    const draft = plan.draft as CustomizeDraft;
    const labels = applyParts(draft);
    text = `Applying the change${draft.changes.length + draft.renames.length > 1 ? "s" : ""} to ${draft.capability}. This takes a few seconds.`;
    rows = labels.map((label, i) => ({ label, state: i === 0 ? "doing" : "next" }));
    await show();
    // Each part is checked as the list moves; the change set itself is one transaction at the end.
    const edits: Edits = new Map(draft.edits);
    for (let i = 1; i < labels.length; i++) {
      rows = rows.map((r, j) => ({ ...r, state: j < i ? "done" : j === i ? "doing" : "next" }));
      await show();
    }
    const out = await k(async (tx, c) => {
      const applied = await applyCustomize(tx, c, job.capabilityId, edits, job.chatId, draft.title);
      await markCreated(tx, planId, job.capabilityId, applied.changeSetId);
      await touchChat(tx, c, job.chatId, { capabilityIds: [...edits.keys()] });
      // Named by what it last changed (12b): "Customer contracts: Legal review step".
      if (draft.title) await renameChat(tx, c, job.chatId, `${draft.capability}: ${draft.title}`);
      return applied;
    });
    rows = rows.map((r) => ({ ...r, state: "done" }));
    await show([{ kind: "text", text: `Done. ${draft.capability} is at version ${out.versions.get(job.capabilityId)}.` }], "done");
    await writeSuggestions(job, out.versions.get(job.capabilityId)!);
  } catch (e) {
    if (!(e instanceof KernelError)) console.error(e);
    rows = rows.map((r) => (r.state === "doing" ? { ...r, state: "failed" } : r));
    await show([{ kind: "text", text: e instanceof KernelError ? e.message : TRY_AGAIN }], "failed");
  }
}

// The chips for the new version, from the small model. A failure leaves no chips; nothing else waits on it.
export async function writeSuggestions(job: Pick<Job, "workspaceId" | "person" | "capabilityId">, version: number): Promise<void> {
  const k = <T>(fn: (tx: Tx) => Promise<T>) => withWorkspace({ workspaceId: job.workspaceId, personId: job.person.id }, fn);
  try {
    const { files, list, personName, formats } = await k(async (tx) => {
      const loaded = await load(tx);
      return {
        formats: loaded.formats,
        files: new Map([...loaded.files].map(([id, f]) => [id, f.file] as const)),
        list: await tx.select({ name: people.name, email: people.email }).from(people).orderBy(people.name),
        personName: (id: string) => loaded.people.get(id)?.name,
      };
    });
    const text = renderCapabilityText(files.get(job.capabilityId)!, { capId: job.capabilityId, files, personName, viewerId: null, withoutForm: true, formats })
      .map((s) => [s.heading, ...s.lines].join("\n"))
      .join("\n\n");
    const out = await ask(customizeSuggestions, { capability: customizeDescription(job.capabilityId, files, personName), text, people: list }, { workspaceId: job.workspaceId, personId: job.person.id, capabilityId: job.capabilityId }, { building: false });
    const kept = keepSuggestions(out.suggestions, files.get(job.capabilityId)!, list.map((p) => p.name));
    await k((tx) => saveSuggestions(tx, job.workspaceId, job.capabilityId, version, kept));
  } catch (e) {
    if (!(e instanceof AiError)) console.error(e);
  }
}
