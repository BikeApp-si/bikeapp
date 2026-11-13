import { and, eq, inArray } from "drizzle-orm";
import { aiSteps, proposals, rows } from "@/db/schema";
import { displayValue } from "@/lib/format";
import { accessTo } from "./access";
import { record } from "./audit";
import { currentTime } from "./clock";
import { AccessError, KernelError, load, type KernelCtx } from "./context";
import { getRow, updateRow } from "./rows";
import { findRule } from "./rule-set";
import type { Column, Sheet } from "./schema/file";
import type { Tx } from "./tx";
import { waitingRowIds } from "./waiting";

// Proposals (8h): what an AI step suggested for a row, waiting on a person. The kernel reads the row for the
// step, checks the answer is a value the column takes, and keeps it apart from the row; only Confirm or
// Change writes it, through the kernel's own edit. A row with a proposal waiting doesn't move on until then.

export const SURE = 0.8;

type Data = Record<string, unknown>;

// What one AI step reads: its row's own columns in plain words, the question and the column it answers, who
// confirms, and the row's receipt, if it holds one.
export async function aiStepWork(tx: Tx, aiStepId: string) {
  const [step] = await tx.select().from(aiSteps).where(eq(aiSteps.id, aiStepId));
  if (!step || step.status !== "queued") return null;
  const loaded = await load(tx);
  const [row] = await tx.select().from(rows).where(eq(rows.id, step.rowId));
  const cap = loaded.files.get(step.capabilityId);
  const sheet = cap?.file.sheets.find((s) => s.id === row?.sheetId);
  const column = sheet?.columns.find((c) => c.id === step.columnId);
  if (!row || row.deletedAt || !cap || !sheet || !column) return { step, skip: true as const };
  const rule = findRule(loaded.rules, step.ruleSource, step.ruleId)?.rule;
  const action = rule?.actions.find((a) => a.kind === "ai_step" && a.column === column.id);
  const data = row.data as Data;
  const names = {
    person: (id: string) => loaded.people.get(id)?.name ?? "",
    step: (id: string) => sheet.steps?.find((s) => s.id === id)?.name ?? "",
  };
  const values: Record<string, string> = {};
  for (const c of sheet.columns) {
    if (c.type === "file" || c.type === "link" || c.id === column.id) continue;
    const text = displayValue(c, data[c.id], names, loaded.formats);
    if (text) values[c.name] = text;
  }
  const receipt = sheet.columns.filter((c) => c.type === "file").map((c) => data[c.id]).find((v): v is string => typeof v === "string") ?? null;
  return {
    step,
    skip: false as const,
    capability: cap.file.name,
    sheet,
    column,
    rowName: sheet.row?.one ?? "row",
    values,
    receipt,
    personId: action?.kind === "ai_step" ? (action.person ?? null) : null,
  };
}

const choiceOf = (column: Column, name: string) => column.options?.find((o) => o.name.toLowerCase() === name.trim().toLowerCase());

// The answer is a value the column takes: one of a choice column's choices, or plain text.
export function checkAnswer(value: string, column: Column): string[] {
  if (column.type === "choice" && !choiceOf(column, value)) return [`“${value}” isn't one of ${column.name}'s choices: ${column.options?.map((o) => o.name).join(", ")}.`];
  if (!["choice", "text", "long_text"].includes(column.type)) return [`${column.name} can't take a suggested value.`];
  return [];
}

const stored = (column: Column, value: string) => (column.type === "choice" ? choiceOf(column, value)!.id : value.trim());

// The step's answer, kept as a proposal (never written into the row), with its Audit entry.
export async function saveProposal(
  tx: Tx,
  ctx: KernelCtx,
  work: Exclude<Awaited<ReturnType<typeof aiStepWork>>, null | { skip: true }>,
  answer: { value: string; reason: string; confidence: number },
) {
  const at = ctx.now ?? currentTime();
  await tx.insert(proposals).values({
    workspaceId: ctx.workspaceId,
    capabilityId: work.step.capabilityId,
    rowId: work.step.rowId,
    columnId: work.column.id,
    aiStepId: work.step.id,
    value: stored(work.column, answer.value),
    reason: answer.reason,
    confidence: answer.confidence,
    personId: work.personId,
    createdAt: at,
  });
  await tx.update(aiSteps).set({ status: "done" }).where(eq(aiSteps.id, work.step.id));
  await record(tx, ctx, {
    who: "Bike",
    capabilityId: work.step.capabilityId,
    event: "proposal.created",
    details: { sheet: work.sheet.name, row: work.values[work.sheet.columns.find((c) => c.id === work.sheet.titleColumn)?.name ?? ""] ?? "", column: work.column.name, value: answer.value, confidence: answer.confidence },
    at,
  });
}

export async function endStep(tx: Tx, aiStepId: string, status: "failed" | "skipped") {
  await tx.update(aiSteps).set({ status }).where(eq(aiSteps.id, aiStepId));
}

// ── For the person who confirms ──

export type ProposalView = {
  id: string;
  rowId: string;
  sheetId: string;
  column: string;
  value: string;
  reason: string;
  confidence: number;
  sure: boolean;
  choices: { id: string; name: string }[]; // for Change, when the column is a choice
  title: string;
  person: { id: string; name: string; column: string } | null; // the row's first person column (8h's Who)
  amount: { text: string; column: string } | null; // its first money column (8h's Amount)
  receipt: boolean;
};

async function mayDecide(tx: Tx, ctx: KernelCtx, p: typeof proposals.$inferSelect): Promise<boolean> {
  if (p.personId) return p.personId === ctx.actor.id;
  const access = await accessTo(tx, await load(tx), p.capabilityId, ctx.actor.id);
  const [row] = await tx.select().from(rows).where(eq(rows.id, p.rowId));
  return !!access && !!row && (await access.allows("edit", { ...row, data: row.data as Data }));
}

// The proposals waiting on this person in a capability, by row.
export async function proposalsFor(tx: Tx, ctx: KernelCtx, capabilityId: string): Promise<ProposalView[]> {
  const loaded = await load(tx);
  const cap = loaded.files.get(capabilityId);
  if (!cap) return [];
  const waiting = await tx.select().from(proposals).where(and(eq(proposals.capabilityId, capabilityId), eq(proposals.status, "waiting")));
  const out: ProposalView[] = [];
  const person = (id: string) => loaded.people.get(id)?.name ?? "";
  for (const p of waiting) {
    if (!(await mayDecide(tx, ctx, p))) continue;
    const [row] = await tx.select().from(rows).where(eq(rows.id, p.rowId));
    const sheet = cap.file.sheets.find((s) => s.id === row?.sheetId);
    const column = sheet?.columns.find((c) => c.id === p.columnId);
    if (!row || row.deletedAt || !sheet || !column) continue;
    const data = row.data as Data;
    const titleCol = sheet.columns.find((c) => c.id === sheet.titleColumn);
    const personCol = sheet.columns.find((c) => c.type === "person" && c.id !== sheet.titleColumn && typeof data[c.id] === "string");
    const moneyCol = sheet.columns.find((c) => c.type === "money" && typeof data[c.id] === "number");
    out.push({
      id: p.id,
      rowId: p.rowId,
      sheetId: sheet.id,
      column: column.name,
      value: displayValue(column, p.value, {}, loaded.formats),
      reason: p.reason,
      confidence: p.confidence,
      sure: p.confidence >= SURE,
      choices: column.options?.map((o) => ({ id: o.id, name: o.name })) ?? [],
      title: titleCol ? displayValue(titleCol, data[titleCol.id], { person }, loaded.formats) : "",
      person: personCol ? { id: data[personCol.id] as string, name: person(data[personCol.id] as string), column: personCol.name } : null,
      amount: moneyCol ? { text: displayValue(moneyCol, data[moneyCol.id], {}, loaded.formats), column: moneyCol.name } : null,
      receipt: sheet.columns.some((c) => c.type === "file" && typeof data[c.id] === "string"),
    });
  }
  return out;
}

async function decide(tx: Tx, ctx: KernelCtx, id: string, value: unknown, event: "proposal.confirmed" | "proposal.changed") {
  const [p] = await tx.select().from(proposals).where(eq(proposals.id, id));
  if (!p) throw new AccessError("That suggestion doesn't exist.");
  if (p.status !== "waiting") throw new KernelError("That suggestion has already been confirmed or changed.");
  if (!(await mayDecide(tx, ctx, p))) throw new AccessError("That suggestion waits on someone else.");
  const at = ctx.now ?? currentTime();
  // Settled first, so the row's own edit isn't held by its waiting suggestion.
  await tx.update(proposals).set({ status: event === "proposal.confirmed" ? "confirmed" : "changed", decidedBy: ctx.actor.id, decidedAt: at }).where(eq(proposals.id, id));
  await updateRow(tx, ctx, p.rowId, { [p.columnId]: value });
  const row = await getRow(tx, ctx, p.rowId);
  const loaded = await load(tx);
  const sheet = loaded.files.get(p.capabilityId)!.file.sheets.find((s: Sheet) => s.id === row.sheetId)!;
  const column = sheet.columns.find((c) => c.id === p.columnId)!;
  const titleColumn = sheet.columns.find((c) => c.id === sheet.titleColumn);
  const title = titleColumn ? displayValue(titleColumn, row.data[titleColumn.id], { person: (pid) => loaded.people.get(pid)?.name ?? "" }, loaded.formats) : "";
  await record(tx, ctx, {
    who: ctx.actor.email,
    capabilityId: p.capabilityId,
    event,
    details: { sheet: sheet.name, row: title, column: column.name, suggested: displayValue(column, p.value, {}, loaded.formats), value: displayValue(column, value, {}, loaded.formats) },
    at,
  });
}

export async function confirmProposal(tx: Tx, ctx: KernelCtx, id: string) {
  const [p] = await tx.select({ value: proposals.value }).from(proposals).where(eq(proposals.id, id));
  if (!p) throw new AccessError("That suggestion doesn't exist.");
  await decide(tx, ctx, id, p.value, "proposal.confirmed");
}

// Change: the person's own value instead (for a choice column, a choice's id).
export async function changeProposal(tx: Tx, ctx: KernelCtx, id: string, value: unknown) {
  await decide(tx, ctx, id, value, "proposal.changed");
}

// "Confirm the N sure ones" (8h): every proposal waiting on this person in the capability at 0.8 or more.
export async function confirmSure(tx: Tx, ctx: KernelCtx, capabilityId: string): Promise<number> {
  const sure = (await proposalsFor(tx, ctx, capabilityId)).filter((p) => p.sure);
  for (const p of sure) await confirmProposal(tx, ctx, p.id);
  return sure.length;
}

// Rows with a proposal still waiting (they don't move on until it is settled).
export async function rowsWithProposals(tx: Tx, rowIds: string[]): Promise<Set<string>> {
  if (!rowIds.length) return new Set();
  const found = await tx.select({ rowId: proposals.rowId }).from(proposals).where(and(inArray(proposals.rowId, rowIds), eq(proposals.status, "waiting")));
  return new Set(found.map((f) => f.rowId));
}

// The rows waiting on this person that Waiting on me's table lists below 8h's: those whose suggestions they
// have settled (or never had), so a row isn't listed twice.
export async function waitingBelowSuggestions(tx: Tx, ctx: KernelCtx, capId: string, sheetId: string): Promise<string[]> {
  const shown = new Set((await proposalsFor(tx, ctx, capId)).map((p) => p.rowId));
  return (await waitingRowIds(tx, ctx, capId, sheetId)).filter((id) => !shown.has(id));
}
