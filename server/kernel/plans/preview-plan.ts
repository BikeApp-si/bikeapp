import { mustBeAdmin } from "../admin";
import { KernelError, startWork, type KernelCtx } from "../context";
import { previewOn } from "../preview";
import type { Tx } from "../tx";
import type { CheckedPlan } from "./plan";

// What a plan's rules would have done on the last 90 days (5j), worked out by the kernel, never the AI. Only
// rules that trigger on sheets that already exist can be replayed: the ones Also changes add to existing
// capabilities. The new capability has no rows yet.
export async function previewPlan(tx: Tx, ctx: KernelCtx, plan: CheckedPlan): Promise<string> {
  await mustBeAdmin(tx, ctx);
  const w = await startWork(tx, ctx);
  const lines: string[] = [];
  for (const [capId, e] of plan.edited) {
    const added = e.after.rules.filter((r) => !e.before.rules.some((b) => b.id === r.id));
    for (const rule of added) {
      try {
        lines.push((await previewOn(w, capId, rule)).summary);
      } catch (err) {
        // A rule that reads what the plan adds can't be replayed on the file as it is today.
        if (!(err instanceof KernelError)) throw err;
      }
    }
  }
  const tail = "Nothing changes until you click Create.";
  return lines.length ? `${lines.join(" ")} ${tail}` : `${plan.file.name} has no rows yet, so there’s nothing to replay. ${tail}`;
}
