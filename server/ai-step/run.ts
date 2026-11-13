import { AiError, ask, NoModel } from "@/server/ai/gateway";
import { aiStep } from "@/server/ai/prompts/ai-step@1";
import { readPdf } from "@/server/files/read";
import { currentTime } from "@/server/kernel/clock";
import { systemCtx } from "@/server/kernel/date-rules";
import { aiStepWork, checkAnswer, endStep, saveProposal } from "@/server/kernel/proposals";
import { rowFile } from "@/server/kernel/uploads";
import { recordFlags } from "@/server/kernel/flags";
import { withWorkspace, type Tx } from "@/server/kernel/tx";

// An AI step a rule queued (prompt 5): the row and its receipt in, a suggestion out, kept as a Proposal that
// waits on a person (8h). Run by the system, reading only that row and the file it holds.

export type AiStepJob = { workspaceId: string; aiStepId: string };

// Receipt photos up to this size go to the model; a larger one is left out and the row's text is read alone.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export async function runAiStep(job: AiStepJob): Promise<void> {
  const ctx = systemCtx(job.workspaceId, currentTime());
  const k = <T>(fn: (tx: Tx) => Promise<T>) => withWorkspace({ workspaceId: job.workspaceId, personId: null }, fn);
  const work = await k((tx) => aiStepWork(tx, job.aiStepId));
  if (!work) return;
  if (work.skip) return k((tx) => endStep(tx, job.aiStepId, "skipped"));

  let document = null;
  let image = null;
  const file = work.receipt ? await k((tx) => rowFile(tx, work.step.rowId, work.receipt!)) : null;
  if (file?.mime === "application/pdf") {
    const { pages, text } = await readPdf(file.body);
    document = { name: file.name, pages, text };
  } else if (file && (file.mime === "image/png" || file.mime === "image/jpeg") && file.body.byteLength <= MAX_IMAGE_BYTES) {
    image = { mediaType: file.mime as "image/png" | "image/jpeg", data: Buffer.from(file.body).toString("base64") };
  }
  try {
    const out = await ask(
      aiStep,
      {
        capability: work.capability,
        rowName: work.rowName,
        question: work.step.question,
        column: { name: work.column.name, type: work.column.type, ...(work.column.options ? { choices: work.column.options.map((o) => o.name) } : {}) },
        values: work.values,
        document,
        image,
      },
      { workspaceId: job.workspaceId, personId: null, capabilityId: work.step.capabilityId },
      { check: (o) => checkAnswer(o.value, work.column), building: false },
    );
    await k(async (tx) => {
      await saveProposal(tx, ctx, work, out);
      // A receipt that tried to direct the step (approve it, change another column): recorded, never followed.
      if (document || out.flags.length) await recordFlags(tx, ctx, { capabilityId: work.step.capabilityId }, document ? [document] : [{ name: file?.name ?? work.rowName, text: "" }], out.flags);
    });
  } catch (e) {
    // No model (O3): the step is skipped, as when its row is gone; the rule's other actions already ran.
    await k((tx) => endStep(tx, job.aiStepId, e instanceof NoModel ? "skipped" : "failed"));
    if (!(e instanceof AiError)) throw e;
  }
}
