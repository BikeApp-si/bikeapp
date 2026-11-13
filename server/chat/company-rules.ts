import { people, workspaces } from "@/db/schema";
import { AiError, ask, TRY_AGAIN } from "@/server/ai/gateway";
import { companyRuleWriter, type CompanyRuleOutput } from "@/server/ai/prompts/company-rule-writer@4";
import { mustBeAdmin } from "@/server/kernel/admin";
import { capabilitiesFor } from "@/server/kernel/capabilities";
import { addMessage, companyChatFor, getPlan, markCreated, readChat, saveDraft, startChat, touchChat, updateMessage, type Part } from "@/server/kernel/chats";
import { compileCompanyRules, type CompiledCompany } from "@/server/kernel/company-compile";
import { previewCompanyRules, problemsOf, saveCompanyRules } from "@/server/kernel/company-rules";
import { KernelError, load, type KernelCtx } from "@/server/kernel/context";
import { formatDay } from "@/lib/format";
import { describeCapability } from "@/server/kernel/plans/structure";
import { companyRulesSchema, type CompanyRule } from "@/server/kernel/schema/company";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import type { CompanyDraft } from "./types";

// The Company rules tab's chat (0.2, M14), like Customize: a message becomes a preview (the rule writer's answer,
// compiled and checked by the kernel, each part replayed on the last 90 days, and warnings), Apply saves the next
// version of the company's rules with a Part / Status reply. Nothing is live until the admin clicks Apply.

type Person = { id: string; email: string };
export type Work = () => Promise<void>;
type Job = { workspaceId: string; person: Person; chatId: string; replyId: string };


// A message in the Company rules chat: written now; the work runs after the response.
export async function sendCompanyRules(tx: Tx, ctx: KernelCtx, text: string): Promise<{ chatId: string; work: Work }> {
  if (!text.trim()) throw new KernelError("Type a message first.");
  await mustBeAdmin(tx, ctx);
  let chatId = await companyChatFor(tx, ctx);
  if (chatId) await addMessage(tx, ctx, chatId, { from: "person", text: text.trim() });
  else {
    chatId = (await startChat(tx, ctx, "company", { text: text.trim() })).chatId;
    await touchChat(tx, ctx, chatId, { title: "Company rules" });
  }
  const replyId = await addMessage(tx, ctx, chatId, { from: "bike", text: "", status: "working" });
  const job = { workspaceId: ctx.workspaceId, person: ctx.actor as Person, chatId, replyId };
  return { chatId, work: () => runCompanyRules(job, text.trim()) };
}

export async function runCompanyRules(job: Job, text: string): Promise<void> {
  const ctx: KernelCtx = { workspaceId: job.workspaceId, actor: job.person };
  const k = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: job.workspaceId, personId: job.person.id }, (tx) => fn(tx, ctx));
  const who = { workspaceId: job.workspaceId, personId: job.person.id, chatId: job.chatId };
  const finish = (m: { text: string; parts?: Part[]; status?: "done" | "failed" }) => k((tx, c) => updateMessage(tx, c, job.replyId, { text: m.text, parts: m.parts ?? [], status: m.status ?? "done" }));

  try {
    const { loaded, files, order, list, company, emails } = await k(async (tx, c) => {
      const loaded = await load(tx);
      // In sidebar order, as the plans list them: the same every time, so the request is too.
      const order = (await capabilitiesFor(tx, c)).map((x) => x.id);
      const [ws] = await tx.select({ name: workspaces.name, timeZone: workspaces.timeZone }).from(workspaces);
      const list = await tx.select({ id: people.id, name: people.name, email: people.email, title: people.title }).from(people).orderBy(people.name);
      return {
        loaded,
        order,
        files: new Map([...loaded.files].map(([id, f]) => [id, f.file] as const)),
        list,
        company: { name: ws!.name, timeZone: ws!.timeZone },
        emails: new Map(list.map((p) => [p.email.toLowerCase(), p.id])),
      };
    });
    const personName = (id: string) => loaded.people.get(id)?.name;
    const current = loaded.company?.rules ?? [];
    const version = loaded.company?.version ?? 0;
    const where = (r: CompanyRule) => r.applications.map((a) => placeOf(files, a.capabilityId, a.trigger.sheet));
    const { messages } = await k((tx, c) => readChat(tx, c, job.chatId));
    const conversation = messages
      .slice(0, -2)
      .filter((m) => m.status === "done")
      .map((m) => ({ from: m.from, text: m.text || (m.parts.some((p) => p.kind === "company") ? "(sent a preview)" : "") }))
      .filter((m) => m.text);

    let compiled: CompiledCompany | null = null;
    const out = await ask(
      companyRuleWriter,
      {
        company,
        capabilities: order.map((id) => describeCapability(id, files, personName)),
        people: list.map((p) => ({ name: p.name, email: p.email, title: p.title })),
        rules: current.map((r) => ({ id: r.id, text: r.text, applies_to: where(r) })),
        conversation,
        request: text,
      },
      who,
      {
        // The kernel's checks are the AI's: a name that doesn't exist, a part that doesn't fit, a loop.
        check: (o) => {
          if (o.type === "clarify") return o.clarify?.options.length ? [] : ["A question needs its choices."];
          if (o.type === "refuse") return [];
          compiled = compileCompanyRules(o, files, emails, current);
          if (compiled.problems.length) return compiled.problems;
          const parsed = companyRulesSchema.safeParse(compiled.rules);
          return parsed.success ? problemsOf(loaded, parsed.data) : parsed.error.issues.map((i) => i.message);
        },
      },
    );
    if (out.type === "clarify" || out.type === "refuse" || !compiled) return void (await finish(notARule(out)));
    const c: CompiledCompany = compiled;
    const change = out.type === "remove" ? ("remove" as const) : out.type === "change" ? ("change" as const) : ("add" as const);

    const preview = await k((tx, cx) => previewCompanyRules(tx, cx, c.rules, c.changed?.id ?? null));
    if (preview.problems.length) return void (await finish({ text: `I can't apply that: ${preview.problems[0]}` }));
    const rule = c.changed ?? c.removed!;
    const draft: CompanyDraft = {
      kind: "company",
      version,
      rules: c.rules,
      ruleId: c.changed?.id ?? null,
      change,
      text: rule.text,
      reply: out.reply,
      when: c.changed?.reading.when ?? null,
      then: c.changed?.reading.then ?? null,
      appliesTo: (c.changed?.applications ?? []).map((a) => ({ where: placeOf(files, a.capabilityId, a.trigger.sheet), when: c.readings[a.id] ?? "" })),
      preview: {
        rows: preview.parts
          .flatMap((p) => p.preview.items.map((i) => ({ title: i.title, where: p.capability, on: i.on })))
          .sort((a, b) => (a.on < b.on ? 1 : a.on > b.on ? -1 : 0))
          .map((r) => ({ ...r, on: formatDay(r.on, loaded.formats) })),
      },
      warnings: preview.warnings,
      button: change === "remove" ? "Remove this rule" : "Apply",
      collapsed: { lead: change === "remove" ? "Removing" : change === "change" ? "Changing" : "Adding", tail: rule.text.replace(/\.$/, "") },
    };
    const plan = await k((tx, cx) => saveDraft(tx, cx, job.chatId, job.replyId, draft));
    await finish({ text: "", parts: [{ kind: "company", planId: plan.id }] });
  } catch (e) {
    if (!(e instanceof AiError) && !(e instanceof KernelError)) console.error(e);
    await finish({ text: e instanceof AiError || e instanceof KernelError ? e.message : TRY_AGAIN, status: "failed" });
  }
}

// "Spend · Expenses".
export const placeOf = (files: ReadonlyMap<string, { name: string; sheets: { id: string; name: string }[] }>, capabilityId: string, sheetId: string) => {
  const f = files.get(capabilityId);
  return `${f?.name ?? "An app"} · ${f?.sheets.find((s) => s.id === sheetId)?.name ?? sheetId}`;
};

// A question with choices, or what a company rule can't be.
function notARule(out: CompanyRuleOutput): { text: string; parts: Part[] } {
  if (out.type === "clarify" && out.clarify) return { text: out.reply, parts: [{ kind: "buttons", buttons: out.clarify.options.map((o) => ({ action: "reply", label: o })) }] };
  return { text: out.reply, parts: [] };
}

// --- Apply ---------------------------------------------------------------------------------------------------

export async function applyCompanyFromChat(tx: Tx, ctx: KernelCtx, chatId: string, planId: string): Promise<{ work: Work }> {
  await mustBeAdmin(tx, ctx);
  const plan = await getPlan(tx, ctx, planId);
  if (plan.chatId !== chatId || plan.status !== "waiting" || (plan.draft as { kind?: string }).kind !== "company") throw new KernelError("That preview has been replaced or applied.");
  const draft = plan.draft as CompanyDraft;
  await addMessage(tx, ctx, chatId, { from: "person", text: draft.button });
  const replyId = await addMessage(tx, ctx, chatId, { from: "bike", text: "", status: "working" });
  return { work: () => runApplyCompany({ workspaceId: ctx.workspaceId, person: ctx.actor as Person, chatId, replyId }, planId) };
}

export const CHECK_RULES = "Check every part fits its app";
export const NOTHING_YET = "Nothing changes for anyone until every part is done.";

// The Part / Status rows: each place the rule applies (or stops), then the check.
export const applyParts = (d: CompanyDraft) => [
  ...(d.change === "remove" ? [`Stop “${d.text.replace(/\.$/, "")}”`] : d.appliesTo.map((a) => `${d.change === "change" ? "Update" : "Add"} it in ${a.where}`)),
  CHECK_RULES,
];

export async function runApplyCompany(job: Job, planId: string): Promise<void> {
  const ctx: KernelCtx = { workspaceId: job.workspaceId, actor: job.person };
  const k = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: job.workspaceId, personId: job.person.id }, (tx) => fn(tx, ctx));
  let rows: { label: string; state: "done" | "doing" | "next" | "failed" }[] = [];
  let text = "";
  const show = (extra: Part[] = [], status?: "done" | "failed") => k((tx, c) => updateMessage(tx, c, job.replyId, { text, parts: [{ kind: "status", head: "Part", rows, note: NOTHING_YET }, ...extra], ...(status ? { status } : {}) }));
  try {
    const plan = await k((tx, c) => getPlan(tx, c, planId));
    const draft = plan.draft as CompanyDraft;
    const labels = applyParts(draft);
    text = draft.change === "remove" ? "Removing the company rule. This takes a few seconds." : "Applying the company rule. This takes a few seconds.";
    rows = labels.map((label, i) => ({ label, state: i === 0 ? "doing" : "next" }));
    await show();
    for (let i = 1; i < labels.length; i++) {
      rows = rows.map((r, j) => ({ ...r, state: j < i ? "done" : j === i ? "doing" : "next" }));
      await show();
    }
    const saved = await k(async (tx, c) => {
      // Refused when the company's rules changed since the preview: what was previewed is no longer what would be saved.
      if (((await load(tx)).company?.version ?? 0) !== draft.version) throw new KernelError("The company rules changed since this preview. Send your message again to see it as it is now.");
      const out = await saveCompanyRules(tx, c, draft.rules, { chatId: job.chatId });
      await markCreated(tx, planId, null, null);
      return out;
    });
    rows = rows.map((r) => ({ ...r, state: "done" }));
    await show([{ kind: "text", text: `Done. Company rules are at version ${saved.version}.` }], "done");
  } catch (e) {
    if (!(e instanceof KernelError)) console.error(e);
    rows = rows.map((r) => (r.state === "doing" ? { ...r, state: "failed" } : r));
    await show([{ kind: "text", text: e instanceof KernelError ? e.message : TRY_AGAIN }], "failed");
  }
}
