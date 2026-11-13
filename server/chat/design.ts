import { AiError, ask, TRY_AGAIN } from "@/server/ai/gateway";
import { capabilityDesigner, type DesignOutput } from "@/server/ai/prompts/capability-designer@11";
import { recordFlags } from "@/server/kernel/flags";
import { logicWriter } from "@/server/ai/prompts/logic-writer@7";
import { summary } from "@/server/kernel/capabilities";
import { readChat, savePlan, touchChat, turnIntoBuild, turnIntoReport, updateMessage, waitingPlan, type Part } from "@/server/kernel/chats";
import type { KernelCtx } from "@/server/kernel/context";
import { planContext, type PlanContext } from "@/server/kernel/plans/context";
import type { DraftRule } from "@/server/kernel/plans/draft";
import { unnamedInRoles } from "@/server/kernel/plans/named";
import { checkPlan, type PlanInput } from "@/server/kernel/plans/plan";
import { previewPlan } from "@/server/kernel/plans/preview-plan";
import { describeCapability } from "@/server/kernel/plans/structure";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { runBuildRead } from "./build-read";
import { runReportJob } from "./report";
import type { PlanDraft } from "./types";

// A message on Home becomes a plan (5a–5f, 5j): the designer (prompt 2), the kernel's check, the logic writer
// (prompt 4) for its rules, the kernel's check of the whole plan and its preview, then the plan reply. The
// Step / Status list in Bike's reply moves as each part is done (5b). Nothing here is live: Create applies it.

export type DesignJob = {
  workspaceId: string;
  person: { id: string; email: string };
  chatId: string;
  replyId: string; // Bike's reply, written as it is worked on
  text: string;
  documents: { name: string; pages: number | null; text: string }[];
  tables?: { file: string; from: string | null; rows: number; header: string[] }[];
};

const steps = (n: number) => ["Understand the request", `Check your ${n} capabilit${n === 1 ? "y" : "ies"} for a fit`, "Draft what to set up"];

// "1 sheet, 5 steps, 2 rules, 2 roles"; with Also changes, "1 sheet, 4 steps, 4 rules, 3 changes" (5j).
export function planSummary(file: Parameters<typeof summary>[0], changes: number): string {
  if (!changes) return summary(file);
  return `${summary(file).split(", ").slice(0, 3).join(", ")}, ${changes} change${changes === 1 ? "" : "s"}`;
}

export async function runDesign(job: DesignJob): Promise<void> {
  const ctx: KernelCtx = { workspaceId: job.workspaceId, actor: job.person };
  const k = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: job.workspaceId, personId: job.person.id }, (tx) => fn(tx, ctx));
  const who = { workspaceId: job.workspaceId, personId: job.person.id, chatId: job.chatId };
  const progress = (labels: string[], doneUpTo: number): Part => ({
    kind: "status",
    head: "Step",
    rows: labels.map((label, i) => ({ label, state: i < doneUpTo ? "done" : i === doneUpTo ? "doing" : "next" })),
  });
  const say = (parts: Part[], text = "") => k((tx, c) => updateMessage(tx, c, job.replyId, { parts, text }));

  try {
    const pc = await k(planContext);
    const labels = steps(pc.order.length);
    await say([progress(labels, 0)], "Working on it.");
    const { messages } = await k((tx, c) => readChat(tx, c, job.chatId));
    const waiting = await k((tx, c) => waitingPlan(tx, c, job.chatId));
    const waitingDraft = waiting?.draft as PlanDraft | undefined;
    // The conversation before this message: what was said, and the plans Bike replied with.
    const before = messages.filter((m) => m.id !== job.replyId).slice(0, -1);
    const conversation = before
      .filter((m) => m.status !== "working")
      .map((m) => ({ from: m.from, text: m.from === "person" ? m.text : m.text || (m.parts.some((p) => p.kind === "plan") ? "(sent the plan)" : "") }))
      .filter((m) => m.text);
    await say([progress(labels, 1)], "Working on it.");

    const newId = waitingDraft?.newId ?? crypto.randomUUID();
    const checkWith = (input: PlanInput) => checkPlan(input, { newId, files: pc.files, people: pc.peopleByEmail, companyRules: pc.companyRules });
    // Who the admin named: in this message, their earlier ones in the chat, and the documents.
    const said = { adminEmail: pc.user.email, people: pc.people, texts: [job.text, ...conversation.filter((m) => m.from === "person").map((m) => m.text), ...job.documents.map((d) => d.text)] };
    const design = await ask(
      capabilityDesigner,
      {
        user: pc.user,
        company: pc.company,
        existing: pc.existing,
        people: pc.people,
        conversation,
        currentPlan: waitingDraft ? { ...waitingDraft.design, rules: waitingDraft.rules } : null,
        latestMessage: job.text,
        documents: job.documents,
        tables: job.tables ?? [],
      },
      who,
      { check: (d) => [...designProblems(d, checkWith, !!waitingDraft), ...(d.capability ? unnamedInRoles(d.capability.roles.map((role) => ({ capability: d.capability!.name, role })), d.also_changes, said) : [])] },
    );
    // Text in the documents that tried to direct Bike: recorded, never followed (a build records its own).
    if (design.type !== "build" && (job.documents.length || design.flags.length)) await k((tx, c) => recordFlags(tx, c, { chatId: job.chatId }, job.documents, design.flags));
    // A question about data: the chat becomes a report chat, and the same reply answers it (11a–11c).
    if (design.type === "report") {
      await k((tx, c) => turnIntoReport(tx, c, job.chatId));
      await runReportJob({ workspaceId: job.workspaceId, person: job.person, chatId: job.chatId, replyId: job.replyId, text: job.text, again: null });
      return;
    }
    // Several capabilities: the chat becomes a build, and the same reply reads the files and plans it (4a–4b).
    if (design.type === "build") {
      await k((tx, c) => turnIntoBuild(tx, c, job.chatId));
      await runBuildRead({ workspaceId: job.workspaceId, person: job.person, chatId: job.chatId, replyId: job.replyId, text: job.text });
      return;
    }
    await say([progress(labels, 2)], "Working on it.");

    if (design.type !== "new_capability" || !design.capability) {
      await finishWith(k, job, design);
      return;
    }

    const { rules, couldNot } = await writeRules(design, pc, newId, checkWith, who);
    const capability = { ...design.capability, later: [...design.capability.later, ...couldNot.map((c) => c.sentence)] };
    const checked = checkWith({ capability, rules, alsoChanges: design.also_changes });
    if (checked.problems.length) throw new AiError(TRY_AGAIN);
    const preview = await k((tx, c) => previewPlan(tx, c, checked));
    const changes = design.also_changes.filter((a) => a.kind === "add").length;
    const draft: PlanDraft = {
      newId,
      design: { ...design, capability },
      rules,
      couldNot,
      summary: planSummary(checked.file, changes),
      preview,
      import: waitingDraft?.import ?? null,
    };
    const plan = await k((tx, c) => savePlan(tx, c, job.chatId, job.replyId, draft, { name: capability.name, summary: draft.summary }));
    await k((tx, c) => updateMessage(tx, c, job.replyId, { text: "", parts: [{ kind: "plan", planId: plan.id }], status: "done" }));
    await k((tx, c) => touchChat(tx, c, job.chatId, { title: capability.name }));
  } catch (e) {
    if (!(e instanceof AiError)) console.error(e);
    await k((tx, c) => updateMessage(tx, c, job.replyId, { text: e instanceof AiError ? e.message : TRY_AGAIN, parts: [], status: "failed" }));
  }
}

// The designer's answer is usable when its capability and Also changes compile; its rules come next.
export function designProblems(d: DesignOutput, checkWith: (i: PlanInput) => { problems: string[] }, waiting: boolean): string[] {
  if (d.type === "build" && waiting) return ["There is a waiting plan; change it rather than starting a build."];
  if (d.type === "clarify" && !d.question?.options.length) return ["A question needs its choices."];
  if (d.type !== "new_capability") return [];
  if (!d.capability) return ["A new app needs its sheets."];
  return checkWith({ capability: d.capability, rules: [], alsoChanges: d.also_changes }).problems;
}

// The rules from the designer's sentences, written by prompt 4 against the plan's structure (the new
// capability first, then the others as the plan leaves them), and checked with the whole plan.
export async function writeRules(
  design: DesignOutput,
  pc: PlanContext,
  newId: string,
  checkWith: (i: PlanInput) => ReturnType<typeof checkPlan>,
  who: { workspaceId: string; personId: string; chatId: string },
): Promise<{ rules: DraftRule[]; couldNot: { sentence: string; reason: string }[] }> {
  if (!design.rule_requests.length || !design.capability) return { rules: [], couldNot: [] };
  const shape = checkWith({ capability: design.capability, rules: [], alsoChanges: design.also_changes });
  const files = new Map([...pc.files, ...[...shape.edited].map(([id, e]) => [id, e.after] as const), [newId, shape.file]]);
  const out = await ask(
    logicWriter,
    {
      company: { name: pc.company.name, timeZone: pc.company.timeZone },
      capabilities: [newId, ...pc.order].map((id) => describeCapability(id, files, pc.personName)),
      people: pc.people.map((p) => ({ name: p.name, email: p.email, title: p.title })),
      sentences: design.rule_requests,
    },
    who,
    { check: (o) => checkWith({ capability: design.capability!, rules: o.rules, alsoChanges: design.also_changes }).problems },
  );
  return { rules: out.rules, couldNot: out.could_not };
}

// A reply that isn't a plan: a question with choices (sent back as the next message), or words pointing to
// where to do it.
async function finishWith(k: <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => Promise<T>, job: DesignJob, d: DesignOutput) {
  const parts: Part[] = d.type === "clarify" && d.question ? [{ kind: "buttons", buttons: d.question.options.map((o) => ({ action: "reply", label: o })) }] : [];
  const text = d.type === "clarify" && d.question ? `${d.lead}\n\n${d.question.text}` : d.lead;
  await k((tx, c) => updateMessage(tx, c, job.replyId, { text, parts, status: "done" }));
}
