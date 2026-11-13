import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { jobs } from "@/db/schema";
import { currentTime } from "@/server/kernel/clock";
import { withWorkspace } from "@/server/kernel/tx";
import type { JobKind } from "./queue";

// Running the jobs the app adds (queue.ts). Each job is claimed in its workspace's transaction (skipping any
// another worker holds), run through the kernel like a request, then marked done or failed. A job's own
// failures are written to its reply by the job itself; `error` keeps what it was for the log.

type Runner = (payload: never) => Promise<void>;
const runners = new Map<JobKind, Runner>();

export function register<P>(kind: JobKind, run: (payload: P) => Promise<void>) {
  runners.set(kind, run as Runner);
}

type Claimed = { id: string; kind: JobKind; payload: unknown };

async function claim(workspaceId: string): Promise<Claimed | null> {
  return withWorkspace({ workspaceId }, async (tx) => {
    const [next] = await tx
      .select({ id: jobs.id, kind: jobs.kind, payload: jobs.payload })
      .from(jobs)
      .where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.status, "queued")))
      .orderBy(asc(jobs.createdAt), asc(jobs.seq))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!next) return null;
    await tx.update(jobs).set({ status: "running", startedAt: currentTime() }).where(eq(jobs.id, next.id));
    return next as Claimed;
  });
}

async function finish(workspaceId: string, id: string, error: string | null) {
  await withWorkspace({ workspaceId }, (tx) =>
    tx.update(jobs).set({ status: error ? "failed" : "done", error, finishedAt: currentTime() }).where(eq(jobs.id, id)),
  );
}

// Runs one claimed job to the end.
async function runOne(workspaceId: string, job: Claimed) {
  const run = runners.get(job.kind);
  try {
    if (!run) throw new Error(`No runner for ${job.kind}`);
    await run(job.payload as never);
    await finish(workspaceId, job.id, null);
  } catch (e) {
    console.error(`Job ${job.kind} ${job.id}:`, e);
    await finish(workspaceId, job.id, e instanceof Error ? e.message : String(e));
  }
}

// Every queued job in a workspace, oldest first, until none is left. Tests call this directly.
export async function runQueued(workspaceId: string): Promise<number> {
  let n = 0;
  for (let job = await claim(workspaceId); job; job = await claim(workspaceId)) {
    await runOne(workspaceId, job);
    n++;
  }
  return n;
}

// Jobs a stopped worker left running can't be picked up halfway: they are marked failed, and their replies
// read as stopped, with Try again.
export async function failInterrupted(workspaceId: string) {
  await withWorkspace({ workspaceId }, (tx) =>
    tx.update(jobs).set({ status: "failed", error: "The worker stopped while this ran.", finishedAt: currentTime() }).where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.status, "running"))),
  );
}

export async function workspaceIds(): Promise<string[]> {
  const found = await db().execute<{ id: string }>(sql`select id from all_workspaces()`);
  return [...found].map((w) => w.id);
}
