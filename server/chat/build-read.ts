import { AiError, ask, TRY_AGAIN } from "@/server/ai/gateway";
import { workspacePlanner, type PlannerOutput } from "@/server/ai/prompts/workspace-planner@2";
import { flagInstructions, readForBuild, type Flag } from "@/server/files/documents";
import { SheetError } from "@/server/files/sheet-reader";
import { readChat, savePlan, touchChat, updateMessage, waitingPlan, type Part } from "@/server/kernel/chats";
import type { KernelCtx } from "@/server/kernel/context";
import { planContext } from "@/server/kernel/plans/context";
import { buildPlanParts, checkBuildPlan, findPeopleTable, knownPeople, matchPeople, readLabel, type ReadTable, type ReadText } from "@/server/kernel/plans/build";
import { openUpload } from "@/server/kernel/uploads";
import { withWorkspace, type Tx } from "@/server/kernel/tx";

// A build chat on Home (4a–4b): the files are read one by one, people are matched across them, and prompt 1
// drafts the plan, checked by the kernel. Bike's reply moves through 4a's Part / Status list and becomes the
// plan (4b). A reply in the chat plans again on top of the waiting plan. Nothing is set up: Build all does it.

export type BuildReadJob = {
  workspaceId: string;
  person: { id: string; email: string };
  chatId: string;
  replyId: string;
  text: string;
};

// The plan as stored in the chat (plans.draft). Build all reads the files again from their uploads.
export type BuildDraft = {
  kind: "build";
  plan: PlannerOutput;
  files: { uploadId: string; name: string }[];
  flags: Flag[]; // lines in the documents that read like instructions, found by the kernel
};

const IMAGE = /\.(png|jpe?g)$/i;

type K = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => Promise<T>;
type FileRef = { uploadId: string; name: string };

// The build's files read from their uploads: text page by page, and every table. Images are left out.
export async function readFiles(k: K, files: FileRef[], onRead?: (f: FileRef, read: { texts: ReadText[]; tables: ReadTable[] }) => Promise<void>) {
  const texts: ReadText[] = [];
  const tables: ReadTable[] = [];
  for (const f of files.filter((x) => !IMAGE.test(x.name))) {
    const body = (await k((tx, c) => openUpload(tx, c, f.uploadId))).body;
    const read = await readForBuild(f.name, body);
    const fileTexts = read.docs.flatMap((d) => (d.kind === "text" ? [{ name: d.name, pages: d.pages, text: d.text }] : []));
    const fileTables = read.docs.flatMap((d) => (d.kind === "table" ? [{ file: d.name, from: d.from, table: d.table }] : []));
    texts.push(...fileTexts);
    tables.push(...fileTables);
    await onRead?.(f, { texts: fileTexts, tables: fileTables });
  }
  return { texts, tables };
}

export async function runBuildRead(job: BuildReadJob): Promise<void> {
  const ctx: KernelCtx = { workspaceId: job.workspaceId, actor: job.person };
  const k = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: job.workspaceId, personId: job.person.id }, (tx) => fn(tx, ctx));
  const say = (parts: Part[], text: string) => k((tx, c) => updateMessage(tx, c, job.replyId, { parts, text }));

  try {
    const { messages } = await k((tx, c) => readChat(tx, c, job.chatId));
    const waiting = await k((tx, c) => waitingPlan(tx, c, job.chatId));
    const before = (waiting?.draft as BuildDraft | undefined) ?? null;
    const files = messages.flatMap((m) => (m.from === "person" ? m.parts : [])).flatMap((p) => (p.kind === "file" && !IMAGE.test(p.name) ? [p] : []));
    const fresh = files.filter((f) => !before?.files.some((b) => b.uploadId === f.uploadId));

    const labels = [...fresh.map((f) => f.name), "Match people across the files", "Draft the plan"];
    const intro = before ? "Working on it." : `Reading your ${files.length} ${files.length === 1 ? "file" : "files"}. Nothing is set up until you've seen the plan.`;
    const shown = [...labels];
    const progress = (upTo: number): Part => ({ kind: "status", head: "Part", rows: shown.map((label, i) => ({ label, state: i < upTo ? "done" : i === upTo ? "doing" : "next" })) });
    await say([progress(0)], intro);

    const { texts, tables } = await readFiles(k, files, async (f, read) => {
      const at = fresh.findIndex((x) => x.uploadId === f.uploadId);
      if (at < 0) return;
      shown[at] = readLabel({ name: f.name, ...read });
      await say([progress(at + 1)], intro);
    });
    const flags = texts.flatMap((t) => flagInstructions({ kind: "text", ...t }));

    const pc = await k(planContext);
    const found = findPeopleTable(tables, pc.user.email);
    const known = knownPeople(tables, found, pc.people.map((p) => ({ name: p.name, email: p.email })));
    const peopleMatches = matchPeople(tables, found?.file ?? null, known, pc.user.email);
    await say([progress(fresh.length + 1)], intro);

    const conversation = messages
      .filter((m) => m.id !== job.replyId && m.status !== "working")
      .slice(0, -1)
      .map((m) => ({ from: m.from, text: m.from === "person" ? m.text : m.parts.some((p) => p.kind === "buttons") ? "(sent the plan)" : m.text }))
      .filter((m) => m.text);
    const existing = pc.order.map((id) => pc.files.get(id)!.name);
    const facts = { texts, tables, existing };
    const plan = await ask(
      workspacePlanner,
      {
        company: { name: pc.company.name, people: pc.company.people },
        user: pc.user,
        existing,
        people: pc.people.map((p) => ({ name: p.name, email: p.email, title: p.title })),
        documents: texts,
        tables: tables.map((t) => ({ file: t.file, from: t.from, rows: Math.max(0, t.table.length - 1), header: t.table[0] ?? [], sample: t.table.slice(1, 21) })),
        peopleMatches,
        conversation,
        currentPlan: before?.plan ?? null,
        latestMessage: job.text,
      },
      { workspaceId: job.workspaceId, personId: job.person.id, chatId: job.chatId },
      { check: (p) => checkBuildPlan(p, facts) },
    );

    const draft: BuildDraft = { kind: "build", plan, files: files.map((f) => ({ uploadId: f.uploadId, name: f.name })), flags };
    const title = `${pc.company.name} from the brief`;
    const summary = `People and ${plan.capabilities.length} ${plan.capabilities.length === 1 ? "app" : "apps"}`;
    await k(async (tx, c) => {
      await savePlan(tx, c, job.chatId, job.replyId, draft, { name: title, summary });
      await updateMessage(tx, c, job.replyId, { text: "", parts: buildPlanParts(plan, tables), status: "done" });
      await touchChat(tx, c, job.chatId, { title });
    });
  } catch (e) {
    const known = e instanceof AiError || e instanceof SheetError;
    if (!known) console.error(e);
    await k((tx, c) => updateMessage(tx, c, job.replyId, { text: known ? e.message : TRY_AGAIN, parts: [], status: "failed" }));
  }
}
