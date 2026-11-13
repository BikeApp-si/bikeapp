import { and, eq } from "drizzle-orm";
import { hasModel } from "@/server/kernel/instance-settings";
import { jobs } from "@/db/schema";
import { AiError, ask } from "@/server/ai/gateway";
import { ontologyWriter, type OntologyOutput } from "@/server/ai/prompts/ontology-writer@2";
import { currentTime } from "@/server/kernel/clock";
import type { KernelCtx } from "@/server/kernel/context";
import { coherenceCheck } from "@/server/ai/prompts/coherence-check@2";
import { checkCoherence, coherenceHash, coherenceInputOf, readCoherence, saveCoherence } from "@/server/kernel/coherence";
import { checkOntology, hashOf, ontologyInput, readOf, readOntology, saveOntology, type OntologyWritten } from "@/server/kernel/ontology";
import { enqueue } from "@/server/jobs/queue";
import { withWorkspace, type Tx } from "@/server/kernel/tx";

// Writing the Ontology (4e) with prompt 6, and the coherence check its Worth a look starts with: when what it reads from has changed (by hash), and at most once
// every 10 minutes. A capability created, changed or built, a page that finds it out of date and Regenerate
// all queue it; Build all writes it before its done reply. An answer that doesn't pass keeps the last one.

export const ONTOLOGY_EVERY_MS = 10 * 60 * 1000;

export type OntologyJob = { workspaceId: string; person: { id: string; email: string } };

const toWritten = (o: OntologyOutput): OntologyWritten => ({
  intro: o.intro,
  paragraphs: o.paragraphs,
  sentences: Object.fromEntries(o.sentences.map((s) => [s.capability, s.sentence])),
  phrases: Object.fromEntries(o.phrases.map((p) => [p.connection, p.phrase])),
  worth: o.worth,
});

// Queued once: a second request while one waits adds nothing. With no model (O3) nothing is queued: the Ontology
// is written once a key is added.
export async function queueOntology(tx: Tx, ctx: KernelCtx) {
  if (!(await hasModel())) return;
  const [waiting] = await tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.kind, "ontology"), eq(jobs.status, "queued")));
  if (!waiting) await enqueue(tx, ctx, "ontology", { workspaceId: ctx.workspaceId, person: ctx.actor } satisfies OntologyJob);
}

// Whether it is out of date and may be written now.
export function due(stored: { inputHash: string; writtenAt: Date } | null, hash: string, now = currentTime()): boolean {
  if (!stored) return true;
  return stored.inputHash !== hash && now.getTime() - stored.writtenAt.getTime() >= ONTOLOGY_EVERY_MS;
}

// Returns true when a new version was written.
export async function writeOntology(job: OntologyJob): Promise<boolean> {
  const ctx: KernelCtx = { workspaceId: job.workspaceId, actor: job.person };
  const k = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: job.workspaceId, personId: job.person.id }, (tx) => fn(tx, ctx));
  const input = await k(ontologyInput);
  const hash = hashOf(input);
  const stored = await k((tx) => readOntology(tx));
  if (!due(stored, hash)) return false;
  try {
    const out = await ask(
      ontologyWriter,
      { ...input, previous: stored ? { intro: stored.written.intro, paragraphs: stored.written.paragraphs } : null },
      { workspaceId: job.workspaceId, personId: job.person.id },
      { check: (o) => checkOntology(toWritten(o), input), building: false },
    );
    await k((tx, c) => saveOntology(tx, c, hash, toWritten(out), readOf(input)));
    return true;
  } catch (e) {
    if (e instanceof AiError) return false;
    throw e;
  }
}

// The coherence check (prompt 4's coherence mode) when the capability texts changed. Returns true when it ran.
export async function checkCoherenceNow(job: OntologyJob): Promise<boolean> {
  const ctx: KernelCtx = { workspaceId: job.workspaceId, actor: job.person };
  const k = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: job.workspaceId, personId: job.person.id }, (tx) => fn(tx, ctx));
  const input = await k(ontologyInput);
  const hash = coherenceHash(input);
  if ((await k((tx) => readCoherence(tx)))?.inputHash === hash) return false;
  try {
    const out = await ask(coherenceCheck, coherenceInputOf(input), { workspaceId: job.workspaceId, personId: job.person.id }, { check: (o) => checkCoherence(o.items, input), building: false });
    await k((tx, c) => saveCoherence(tx, c, hash, out.items));
    return true;
  } catch (e) {
    if (e instanceof AiError) return false;
    throw e;
  }
}

export async function runOntology(job: OntologyJob): Promise<void> {
  await checkCoherenceNow(job);
  await writeOntology(job);
}
