import { jobs } from "@/db/schema";
import type { KernelCtx } from "@/server/kernel/context";
import type { Tx } from "@/server/kernel/tx";
import { currentTime } from "@/server/kernel/clock";
import { SYSTEM_ID } from "@/server/kernel/date-rules";

// Adding work for the worker (run.ts). The job is written in the caller's transaction, so it exists only if
// the messages it will answer do; the worker wakes when that transaction commits.

export type JobKind = "design" | "import" | "import-into" | "create" | "build-read" | "build" | "ai-step" | "ontology" | "report";

export async function enqueue(tx: Tx, ctx: KernelCtx, kind: JobKind, payload: object, messageId?: string): Promise<string> {
  const person = ctx.actor.id === SYSTEM_ID ? null : ctx.actor.id;
  const [job] = await tx
    .insert(jobs)
    .values({ workspaceId: ctx.workspaceId, personId: person, kind, payload, messageId: messageId ?? null, createdAt: ctx.now ?? currentTime() })
    .returning({ id: jobs.id });
  return job!.id;
}
