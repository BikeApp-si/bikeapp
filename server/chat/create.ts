import { AiError, TRY_AGAIN } from "@/server/ai/gateway";
import { applyPlan } from "@/server/kernel/changesets";
import { getPlan, markCreated, touchChat, updateMessage, type Part } from "@/server/kernel/chats";
import { KernelError, type KernelCtx } from "@/server/kernel/context";
import { planContext } from "@/server/kernel/plans/context";
import { capabilityId } from "@/server/kernel/plans/names";
import { checkImport } from "@/server/kernel/plans/import-check";
import { canMove, checkPlan } from "@/server/kernel/plans/plan";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { peopleOf, readUpload } from "./import";
import type { PlanDraft } from "./types";

// Create (5h, 5j, 5l): the plan checked again against the workspace as it is now, then applied as one change set,
// with any data move it makes (M27). A move Bike can't do yet is only named; Go ahead without it leaves it out. The Part / Status list moves as each part is checked; nothing goes live until
// every part is ready, because the change set is one transaction at the end.

export type CreateJob = {
  workspaceId: string;
  person: { id: string; email: string };
  chatId: string;
  replyId: string;
  planId: string;
  withImport: boolean;
  withoutRestructure: boolean; // 5l: Go ahead without it (a data move Bike can't do yet)
};

type Row = { label: string; state: "done" | "doing" | "next" | "failed" };

export function createParts(draft: PlanDraft): string[] {
  const c = draft.design.capability!;
  const edited = [...new Set(draft.design.also_changes.filter((a) => a.kind === "add" || canMove(a)).map((a) => a.capability))];
  // A data move is its own part: "Link Customer to Customers".
  const moves = draft.design.also_changes.filter(canMove).flatMap((a) => a.edits.flatMap((e) => (e.link ? [`Link ${e.link.column} to ${e.link.to_sheet}`] : [])));
  return [
    `Sheet: ${c.sheets.map((s) => s.name).join(", ")}`,
    "Steps",
    "Access",
    "Rules",
    ...edited.map((name) => `Changes in ${name}`),
    ...moves,
    ...(draft.import ? [`Data: ${draft.import.rows} ${draft.import.rows === 1 ? "row" : "rows"}`] : []),
    "Overview and views",
    "Connections",
  ];
}

export async function runCreate(job: CreateJob): Promise<void> {
  const ctx: KernelCtx = { workspaceId: job.workspaceId, actor: job.person };
  const k = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: job.workspaceId, personId: job.person.id }, (tx) => fn(tx, ctx));
  let rows: Row[] = [];
  let text = "";
  const NOTE = "You can leave this page. I’ll email you when it’s ready. Nothing goes live until every part is ready.";
  const show = (extra: Part[] = []) => k((tx, c) => updateMessage(tx, c, job.replyId, { text, parts: [{ kind: "status", head: "Part", rows, note: NOTE }, ...extra] }));
  const step = async (i: number) => {
    rows = rows.map((r, j) => ({ ...r, state: j < i ? "done" : j === i ? "doing" : "next" }));
    await show();
  };

  try {
    const plan = await k((tx, c) => getPlan(tx, c, job.planId));
    if (plan.chatId !== job.chatId || plan.status !== "waiting") throw new KernelError("That plan has been replaced or created.");
    const draft = plan.draft as PlanDraft;
    const design = draft.design;
    const name = design.capability!.name;
    const labels = createParts({ ...draft, import: job.withImport ? draft.import : null });
    text = `Creating **${name}**. This usually takes under a minute.`;
    rows = labels.map((label, i) => ({ label, state: i === 0 ? "doing" : "next" }));
    await show();

    const restructures = design.also_changes.filter((a) => a.kind === "restructure" && !canMove(a));
    if (restructures.length && !job.withoutRestructure) throw new KernelError("One change moves data in a way Bike can’t do yet. Go ahead without it, or reply to change the plan.");
    const pc = await k(planContext);
    const alsoChanges = design.also_changes.filter((a) => a.kind === "add" || canMove(a));
    const checked = checkPlan({ capability: design.capability!, rules: draft.rules, alsoChanges }, { newId: draft.newId, files: pc.files, people: pc.peopleByEmail, companyRules: pc.companyRules });
    for (let i = 1; i < labels.length; i++) await step(i);
    if (checked.problems.length) throw new KernelError(`${name} can’t be created as planned: ${checked.problems[0]}`, checked.problems);

    // The file's rows, read again with the mapping that was checked.
    let imported = null;
    if (job.withImport && draft.import) {
      const { table } = await k((tx, c) => readUpload(tx, c, draft.import!.uploadId));
      const people = await k(peopleOf);
      const sheet = checked.file.sheets[0]!;
      imported = { sheetId: sheet.id, rows: checkImport(sheet, table, draft.import.using, people).rows, fileName: draft.import.fileName };
    }
    const changes = new Map<string, string[]>();
    const world = { newId: draft.newId, newName: name, files: pc.files, people: pc.peopleByEmail, companyRules: pc.companyRules };
    for (const a of alsoChanges) {
      const id = capabilityId(world, a.capability, draft.newId);
      if (id) changes.set(id, [...(changes.get(id) ?? []), a.change]);
    }
    await k(async (tx, c) => {
      const out = await applyPlan(tx, c, { plan: checked, newId: draft.newId, chatId: job.chatId, changes, imports: imported ? [imported] : [] });
      await markCreated(tx, plan.id, out.capabilityId, out.changeSetId);
      await touchChat(tx, c, job.chatId, { capabilityIds: [out.capabilityId, ...changes.keys()] });
    });
    rows = rows.map((r) => ({ ...r, state: "done" }));
    await k((tx, c) =>
      updateMessage(tx, c, job.replyId, {
        text,
        parts: [{ kind: "status", head: "Part", rows }, { kind: "link", label: `Open ${name}`, href: `/c/${draft.newId}` }],
        status: "done",
      }),
    );
  } catch (e) {
    if (!(e instanceof KernelError) && !(e instanceof AiError)) console.error(e);
    rows = rows.map((r) => (r.state === "doing" ? { ...r, state: "failed" } : r));
    const why = e instanceof KernelError || e instanceof AiError ? e.message : TRY_AGAIN;
    await k((tx, c) => updateMessage(tx, c, job.replyId, { text: text ? `${text}\n\n${why}` : why, parts: rows.length ? [{ kind: "status", head: "Part", rows }] : [], status: "failed" }));
  }
}
