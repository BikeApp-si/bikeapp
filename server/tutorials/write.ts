import { AiError, ask } from "@/server/ai/gateway";
import type { Who } from "@/server/ai/log";
import { tutorialWriter } from "@/server/ai/prompts/tutorial-writer@3";
import type { KernelCtx } from "@/server/kernel/context";
import { checkTutorial, saveTutorial, tutorialState, type Tutorial, type TutorialState } from "@/server/kernel/tutorial";
import { withWorkspace, type Tx } from "@/server/kernel/tx";

// A capability's tutorial for this person (0.4, M24): read back when one exists for their access and the capability's
// version; otherwise written once by the small model from their access summary, checked by the kernel (one retry
// with its problems), kept, and read back. The AI call runs outside the kernel's transactions.
export async function tutorialFor(ctx: KernelCtx, capId: string): Promise<{ ok: true; state: Extract<TutorialState, { ready: true }> } | { ok: false; error: string }> {
  const k = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: ctx.workspaceId, personId: ctx.actor.id }, (tx) => fn(tx, ctx));
  const first = await k((tx, c) => tutorialState(tx, c, capId));
  if (first.ready) return { ok: true, state: first };
  const who: Who = { workspaceId: ctx.workspaceId, personId: ctx.actor.id, capabilityId: capId };
  let page: Tutorial;
  try {
    page = await ask(tutorialWriter, { company: first.company, access: first.summary }, who, { building: false, check: (o) => checkTutorial(first.summary, o) });
  } catch (e) {
    if (e instanceof AiError) return { ok: false, error: `Bike couldn't write ${first.capability}'s tutorial just now. Try again in a moment.` };
    throw e;
  }
  await k((tx, c) => saveTutorial(tx, c, capId, first.version, first.hash, page));
  const now = await k((tx, c) => tutorialState(tx, c, capId));
  if (!now.ready) return { ok: false, error: `Bike couldn't write ${first.capability}'s tutorial just now. Try again in a moment.` };
  return { ok: true, state: now };
}
