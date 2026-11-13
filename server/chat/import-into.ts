import { AiError, ask, TRY_AGAIN } from "@/server/ai/gateway";
import { importMapping } from "@/server/ai/prompts/import-mapping@1";
import { recordFlags } from "@/server/kernel/flags";
import { readChat, touchChat, updateMessage, type Part } from "@/server/kernel/chats";
import { KernelError, load, type KernelCtx } from "@/server/kernel/context";
import { checkImport, type Mapping } from "@/server/kernel/plans/import-check";
import { importRows } from "@/server/kernel/rows";
import type { Sheet } from "@/server/kernel/schema/file";
import { capabilityView } from "@/server/kernel/views";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { peopleOf, readUpload } from "./import";
import type { ImportDraft } from "./types";

// "Import a spreadsheet" from a capability with no rows yet (5i): a CSV read into one of its sheets, as 5g
// reads one into a plan. Prompt 2b maps the columns; the kernel reads every row and names those that need a
// check; nothing is imported until "Import N rows", and then all or nothing, with the person's own access.

export type ImportIntoJob = { workspaceId: string; person: { id: string; email: string }; chatId: string; replyId: string; uploadId: string; capabilityId: string };

// The sheet a file goes into: the first one the person can add rows to.
async function targetSheet(tx: Tx, ctx: KernelCtx, capabilityId: string): Promise<{ name: string; sheet: Sheet }> {
  const view = await capabilityView(tx, ctx, capabilityId);
  const into = view.sheets.find((s) => s.canAdd);
  if (!into) throw new KernelError(`You can't add rows to ${view.name}.`);
  const file = (await load(tx)).files.get(capabilityId)!.file;
  return { name: view.name, sheet: file.sheets.find((s) => s.id === into.id)! };
}

export async function runImportInto(job: ImportIntoJob): Promise<void> {
  const ctx: KernelCtx = { workspaceId: job.workspaceId, actor: job.person };
  const k = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: job.workspaceId, personId: job.person.id }, (tx) => fn(tx, ctx));
  try {
    const { name, sheet } = await k((tx, c) => targetSheet(tx, c, job.capabilityId));
    const { name: fileName, table } = await k((tx, c) => readUpload(tx, c, job.uploadId));
    const [header = [], ...lines] = table;
    if (!lines.length) throw new AiError(`${fileName} has no rows to import.`);
    // Cells that try to direct Bike are recorded, never followed (the kernel's check: the mapping has no flags).
    await k((tx, c) => recordFlags(tx, c, { chatId: job.chatId }, [{ name: fileName, text: table.map((r) => r.join(" ")).join("\n") }], []));
    const people = await k(peopleOf);
    const columns = sheet.columns
      .filter((c) => c.type !== "computed")
      .map((c) => ({ name: c.name, type: c.type, ...(c.type === "step" ? { choices: sheet.steps?.map((s) => s.name) } : c.options ? { choices: c.options.map((o) => o.name) } : {}) }));
    const mapped = await ask(
      importMapping,
      { target: { capability: name, sheet: sheet.name, columns }, file: { name: fileName, header, sample: lines.slice(0, 20) } },
      { workspaceId: job.workspaceId, personId: job.person.id, capabilityId: job.capabilityId, chatId: job.chatId },
      { check: (o) => checkImport(sheet, table, o.mapping, people).problems, building: false },
    );
    const using: Mapping[] = mapped.mapping;
    const checked = checkImport(sheet, table, using, people);
    const draft: ImportDraft = {
      uploadId: job.uploadId,
      fileName,
      sheet: sheet.name,
      rows: checked.rows.length,
      columns: header.length,
      mapping: checked.mapping,
      unmapped: checked.unmapped,
      checks: checked.checks,
      using,
    };
    const parts: Part[] = [{ kind: "import_rows", capabilityId: job.capabilityId, capability: name, rows: sheet.row ?? { one: "row", many: "rows" }, draft }];
    await k((tx, c) => updateMessage(tx, c, job.replyId, { text: "", parts, status: "done" }));
    await k((tx, c) => touchChat(tx, c, job.chatId, { title: `Import into ${name}` }));
  } catch (e) {
    if (!(e instanceof AiError) && !(e instanceof KernelError)) console.error(e);
    await k((tx, c) => updateMessage(tx, c, job.replyId, { text: e instanceof AiError || e instanceof KernelError ? e.message : TRY_AGAIN, parts: [], status: "failed" }));
  }
}

// "Import N rows": the file read again with the mapping that was checked, imported in one go.
export async function importChecked(tx: Tx, ctx: KernelCtx, chatId: string, messageId: string): Promise<{ text: string; parts: Part[] }> {
  const { messages } = await readChat(tx, ctx, chatId);
  const part = messages.find((m) => m.id === messageId)?.parts.find((p) => p.kind === "import_rows");
  if (!part || part.kind !== "import_rows") throw new KernelError("That import isn't in this chat.");
  if (messages.some((m) => m.parts.some((p) => p.kind === "imported" && p.messageId === messageId))) throw new KernelError("Those rows have already been imported.");
  const { sheet } = await targetSheet(tx, ctx, part.capabilityId);
  const { table } = await readUpload(tx, ctx, part.draft.uploadId);
  const rows = checkImport(sheet, table, part.draft.using, await peopleOf(tx)).rows;
  await importRows(tx, ctx, part.capabilityId, sheet.id, rows, { source: part.draft.fileName, chatId });
  await touchChat(tx, ctx, chatId, { capabilityIds: [part.capabilityId] });
  const words = rows.length === 1 ? part.rows.one : part.rows.many;
  return {
    text: `**${rows.length} ${words}** ${rows.length === 1 ? "is" : "are"} in ${part.capability}.`,
    parts: [{ kind: "imported", messageId }, { kind: "link", label: `Open ${part.capability}`, href: `/c/${part.capabilityId}` }],
  };
}
