import { parseCsv } from "@/lib/csv";
import { AiError, ask, TRY_AGAIN } from "@/server/ai/gateway";
import { importMapping } from "@/server/ai/prompts/import-mapping@1";
import { recordFlags } from "@/server/kernel/flags";
import { attachImport, updateMessage, waitingPlan, type Part } from "@/server/kernel/chats";
import type { KernelCtx } from "@/server/kernel/context";
import { planContext } from "@/server/kernel/plans/context";
import { checkImport, peopleKeys, type Mapping } from "@/server/kernel/plans/import-check";
import { checkPlan, type CheckedPlan } from "@/server/kernel/plans/plan";
import { openUpload } from "@/server/kernel/uploads";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { load } from "@/server/kernel/context";
import type { ImportDraft, PlanDraft } from "./types";

// A CSV attached while a plan waits (5g): prompt 2b maps its columns from the header and 20 sample rows, the
// kernel reads every row and names those that need a check, and the reply shows it all. The rows are
// imported only on Create, with the capability, all or nothing.

export type ImportJob = { workspaceId: string; person: { id: string; email: string }; chatId: string; replyId: string; uploadId: string };

// The plan's files as they would be created now (the import goes into its first sheet).
export function planNow(draft: PlanDraft, pc: Awaited<ReturnType<typeof planContext>>): CheckedPlan {
  const { design, rules, newId } = draft;
  return checkPlan({ capability: design.capability!, rules, alsoChanges: design.also_changes }, { newId, files: pc.files, people: pc.peopleByEmail, companyRules: pc.companyRules });
}

// The file's rows as the kernel reads them, with the mapping prompt 2b gave.
export async function readUpload(tx: Tx, ctx: KernelCtx, uploadId: string) {
  const file = await openUpload(tx, ctx, uploadId);
  if (!/\.csv$/i.test(file.name)) throw new AiError("Bike reads CSV files for an import. Save the spreadsheet as CSV and attach it again.");
  return { name: file.name, table: parseCsv(new TextDecoder().decode(file.body)) };
}

export const peopleOf = async (tx: Tx) => {
  const loaded = await load(tx);
  return { ...peopleKeys([...loaded.people.values()]), formats: loaded.formats };
};

export async function runImport(job: ImportJob): Promise<void> {
  const ctx: KernelCtx = { workspaceId: job.workspaceId, actor: job.person };
  const k = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: job.workspaceId, personId: job.person.id }, (tx) => fn(tx, ctx));
  try {
    const plan = await k((tx, c) => waitingPlan(tx, c, job.chatId));
    if (!plan) throw new AiError("Describe what you want to manage first; then attach the file to import into it.");
    const draft = plan.draft as PlanDraft;
    const pc = await k(planContext);
    const sheet = planNow(draft, pc).file.sheets[0]!;
    const { name, table } = await k((tx, c) => readUpload(tx, c, job.uploadId));
    const [header = [], ...lines] = table;
    if (!lines.length) throw new AiError(`${name} has no rows to import.`);
    // Cells that try to direct Bike are recorded, never followed (the kernel's check: the mapping has no flags).
    await k((tx, c) => recordFlags(tx, c, { chatId: job.chatId }, [{ name: name, text: table.map((r) => r.join(" ")).join("\n") }], []));
    const people = await k(peopleOf);
    const columns = sheet.columns
      .filter((c) => c.type !== "computed")
      .map((c) => ({ name: c.name, type: c.type, ...(c.type === "step" ? { choices: sheet.steps?.map((s) => s.name) } : c.options ? { choices: c.options.map((o) => o.name) } : {}) }));
    const mapped = await ask(
      importMapping,
      { target: { capability: draft.design.capability!.name, sheet: sheet.name, columns }, file: { name, header, sample: lines.slice(0, 20) } },
      { workspaceId: job.workspaceId, personId: job.person.id, chatId: job.chatId },
      { check: (o) => checkImport(sheet, table, o.mapping, people).problems },
    );
    const using: Mapping[] = mapped.mapping;
    const checked = checkImport(sheet, table, using, people);
    const imported: ImportDraft = {
      uploadId: job.uploadId,
      fileName: name,
      sheet: sheet.name,
      rows: checked.rows.length,
      columns: header.length,
      mapping: checked.mapping,
      unmapped: checked.unmapped,
      checks: checked.checks,
      using,
    };
    await k((tx, c) => attachImport(tx, c, plan.id, imported));
    const parts: Part[] = [{ kind: "import", planId: plan.id }];
    await k((tx, c) => updateMessage(tx, c, job.replyId, { text: "", parts, status: "done" }));
  } catch (e) {
    if (!(e instanceof AiError)) console.error(e);
    await k((tx, c) => updateMessage(tx, c, job.replyId, { text: e instanceof AiError ? e.message : TRY_AGAIN, parts: [], status: "failed" }));
  }
}
