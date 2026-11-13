"use server";

import { asAction } from "@/server/auth/kernel-call";
import { readIntoFormWith } from "@/server/ai-step/read-into-form";
import { wordsToFilters } from "@/server/filters/words";
import { tutorialFor } from "@/server/tutorials/write";
import { closeTutorial, tutorialState } from "@/server/kernel/tutorial";
import { rowHistory as historyOf } from "@/server/kernel/history";
import { addNote } from "@/server/kernel/notes";
import { relatedRows } from "@/server/kernel/related";
import { filterWordsInput } from "@/server/kernel/filter-words";
import { formReading } from "@/server/kernel/read-into-fields";
import { deleteCapability, deleteImpact } from "@/server/kernel/capabilities";
import { load } from "@/server/kernel/context";
import { displayValue } from "@/lib/format";
import { KernelError } from "@/server/kernel/context";
import type { Filter, GroupBy, Sort } from "@/server/kernel/query";
import { boardRows, bulkUpdate, createRow, deletePreview, deleteRows, getRow, groupTotals, listRows, moveStep, movesFor, movesForAll, previewAdd, reverseEntry, sheetTotals, updateRow } from "@/server/kernel/rows";
import { changeProposal, confirmProposal, confirmSure, waitingBelowSuggestions } from "@/server/kernel/proposals";
import { saveUpload } from "@/server/kernel/uploads";
import { linkOptionTitles, namesFor } from "@/server/kernel/views";
import { decide, waitingRowIds, waitsOnRows } from "@/server/kernel/waiting";
import { panelRow } from "./panel";
import { deleteView, saveTablePrefs, saveView, tablePrefsFor, viewsFor, type TableColumns, type ViewInput } from "@/server/kernel/saved-views";

// The Data tab's writes and reads. Each one is a kernel call as the signed-in person; nothing here decides
// who may do what.

const PAGE = 100;

async function sheetFor(tx: Parameters<Parameters<typeof asAction>[0]>[0], capId: string, sheetId: string) {
  const sheet = (await load(tx)).files.get(capId)?.file.sheets.find((s) => s.id === sheetId);
  if (!sheet) throw new KernelError("That sheet doesn't exist, or you can't see it.");
  return sheet;
}

// A part of a sheet's rows, in the table's order, with the names they point at and what waits on whom; the
// totals with the first part. waiting: only the rows waiting on this person (Waiting on me).
export async function loadRows(capId: string, sheetId: string, opts: { filters: Filter[]; sort?: Sort; offset: number; waiting?: boolean; search?: string; groupBy?: GroupBy }) {
  return asAction(async (tx, ctx) => {
    const sheet = await sheetFor(tx, capId, sheetId);
    const only = opts.waiting ? await waitingBelowSuggestions(tx, ctx, capId, sheetId) : undefined;
    const rows = await listRows(tx, ctx, capId, sheetId, { filters: opts.filters, sort: opts.sort, limit: PAGE, offset: opts.offset, only, search: opts.search, groupBy: opts.groupBy });
    const names = await namesFor(tx, ctx, sheet, rows);
    const totals = opts.offset === 0 ? await sheetTotals(tx, ctx, capId, sheetId, { filters: opts.filters, only, search: opts.search }) : null;
    const waits = await waitsOnRows(tx, ctx, capId, sheetId, rows.map((r) => r.id));
    return { rows, names, totals, waits };
  });
}

// One row for the panel: its values, the steps the person can move it to, the names it points at, what waits
// on them in it, and the line under its title.
export async function openRow(rowId: string) {
  return asAction(async (tx, ctx) => panelRow(tx, ctx, rowId));
}

// Approve or Decline what a rule asked this person to decide.
export async function decideRow(waitId: string, choice: "approve" | "decline") {
  return asAction(async (tx, ctx) => ({ id: (await decide(tx, ctx, waitId, choice)).rowId }));
}

// Who a new row would go to, and how the sheet's checks come out, as the form is filled in (8f, 8g).
export async function previewNew(capId: string, sheetId: string, values: Record<string, unknown>) {
  return asAction(async (tx, ctx) => previewAdd(tx, ctx, capId, sheetId, values));
}

export async function saveRow(capId: string, sheetId: string, rowId: string | null, values: Record<string, unknown>) {
  return asAction(async (tx, ctx) => {
    const saved = rowId ? await updateRow(tx, ctx, rowId, values) : await createRow(tx, ctx, capId, sheetId, { values });
    return { id: saved.id };
  });
}

export async function moveRow(rowId: string, stepId: string) {
  return asAction(async (tx, ctx) => ({ id: (await moveStep(tx, ctx, rowId, stepId)).id }));
}

// A linked row's card (0.3, M18): its title, step and a few answers, read as this person (a row they can't see is
// refused, so the link stays plain text).
export async function rowPreview(rowId: string) {
  return asAction(async (tx, ctx) => {
    const row = await getRow(tx, ctx, rowId);
    const loaded = await load(tx);
    const cap = loaded.files.get(row.capabilityId)!;
    const sheet = cap.file.sheets.find((s) => s.id === row.sheetId)!;
    const names = await namesFor(tx, ctx, sheet, [row]);
    const look = { person: (id: string) => names.people[id], row: (id: string) => names.rows[id], file: (id: string) => names.files[id] };
    const text = (id: string) => {
      const c = sheet.columns.find((x) => x.id === id);
      return c ? displayValue(c, row.data[id], look, loaded.formats) : "";
    };
    const stepCol = sheet.columns.find((c) => c.type === "step");
    const step = stepCol ? (sheet.steps ?? []).find((s) => s.id === row.data[stepCol.id]) : undefined;
    const fields = sheet.columns
      .filter((c) => c.id !== sheet.titleColumn && c.type !== "step" && !c.hintFor && c.type !== "file" && text(c.id))
      .slice(0, 3)
      .map((c) => ({ name: c.name, text: text(c.id) }));
    return { id: row.id, capId: row.capabilityId, sheetId: row.sheetId, capName: cap.file.name, title: text(sheet.titleColumn), step: step ?? null, fields };
  });
}

// Groups of a sheet's rows with their counts and subtotals, and a board by step (0.4, M20).
export async function loadGroups(capId: string, sheetId: string, opts: { filters: Filter[]; search?: string; by: GroupBy }) {
  return asAction(async (tx, ctx) => ({ groups: await groupTotals(tx, ctx, capId, sheetId, opts) }));
}

export async function loadBoard(capId: string, sheetId: string, opts: { filters: Filter[]; search?: string; step?: string; offset?: number }) {
  return asAction(async (tx, ctx) => {
    const sheet = await sheetFor(tx, capId, sheetId);
    const columns = await boardRows(tx, ctx, capId, sheetId, opts);
    const names = await namesFor(tx, ctx, sheet, columns.flatMap((c) => c.rows));
    return { columns, names };
  });
}

// Saved views and how a person arranges a sheet's table (0.4, M19).
export async function sheetViews(capId: string, sheetId: string) {
  return asAction(async (tx, ctx) => ({ views: await viewsFor(tx, ctx, capId, sheetId), prefs: await tablePrefsFor(tx, ctx, capId, sheetId) }));
}

export async function saveSheetView(capId: string, sheetId: string, input: ViewInput, id?: string) {
  return asAction(async (tx, ctx) => ({ view: await saveView(tx, ctx, capId, sheetId, input, id) }));
}

export async function removeSheetView(id: string) {
  return asAction(async (tx, ctx) => (await deleteView(tx, ctx, id), {}));
}

export async function saveColumns(capId: string, sheetId: string, columns: TableColumns | null) {
  return asAction(async (tx, ctx) => (await saveTablePrefs(tx, ctx, capId, sheetId, columns), {}));
}

// The steps this person may move one row to, for a status pill in a table (0.3).
export async function rowMoves(rowId: string) {
  return asAction(async (tx, ctx) => ({ moves: await movesFor(tx, ctx, rowId) }));
}

export async function previewDelete(rowIds: string[]) {
  return asAction(async (tx, ctx) => deletePreview(tx, ctx, rowIds));
}

export async function removeRows(rowIds: string[]) {
  return asAction(async (tx, ctx) => deleteRows(tx, ctx, rowIds));
}

// Reverse (M29): the kernel adds the entry that reverses this one.
export async function reverseRow(rowId: string) {
  return asAction(async (tx, ctx) => reverseEntry(tx, ctx, rowId));
}

export async function commonMoves(rowIds: string[]) {
  return asAction(async (tx, ctx) => ({ moves: await movesForAll(tx, ctx, rowIds) }));
}

export async function bulkChange(rowIds: string[], change: { values: Record<string, unknown> } | { step: string }) {
  return asAction(async (tx, ctx) => bulkUpdate(tx, ctx, rowIds, change));
}

export async function uploadFile(form: FormData) {
  const file = form.get("file");
  if (!(file instanceof File)) return { ok: false as const, error: "Pick a file to attach.", problems: [] };
  const body = new Uint8Array(await file.arrayBuffer());
  return asAction(async (tx, ctx) => saveUpload(tx, ctx, { name: file.name, body }));
}

export async function capabilityImpact(capId: string) {
  return asAction(async (tx, ctx) => deleteImpact(tx, ctx, capId));
}

export async function removeCapability(capId: string, typedName: string) {
  return asAction(async (tx, ctx) => {
    await deleteCapability(tx, ctx, capId, typedName);
    return { next: "/home" };
  });
}

// The rows a link field can point at: the ones the person can see, by name.
export async function linkOptions(capId: string, sheetId: string) {
  return asAction(async (tx, ctx) => {
    const sheet = await sheetFor(tx, capId, sheetId);
    const rows = await listRows(tx, ctx, capId, sheetId);
    return { options: await linkOptionTitles(tx, ctx, sheet, rows) };
  });
}

// 8h: an AI step's suggestion, confirmed or changed by the person it waits on, or every sure one at once.
export async function confirmSuggestion(id: string) {
  return asAction(async (tx, ctx) => (await confirmProposal(tx, ctx, id), {}));
}

export async function changeSuggestion(id: string, value: string) {
  return asAction(async (tx, ctx) => (await changeProposal(tx, ctx, id, value), {}));
}

export async function confirmSureSuggestions(capId: string) {
  return asAction(async (tx, ctx) => ({ confirmed: await confirmSure(tx, ctx, capId) }));
}

// 7c's "Drop the signed PDF": the dropped file is read by prompt 5's form mode, and the kernel turns its
// answer into the form's values. Nothing is saved; the AI call runs outside the kernel's transactions.
export async function readIntoForm(capId: string, sheetId: string, uploadId: string) {
  const prep = await asAction(async (tx, ctx) => ({
    r: await formReading(tx, ctx, capId, sheetId, uploadId),
    who: { workspaceId: ctx.workspaceId, personId: ctx.actor.id, capabilityId: capId },
  }));
  if (!prep.ok) return prep;
  return readIntoFormWith(prep.r, uploadId, prep.who);
}

// Filters in plain words (0.4, M21): the kernel gives the prompt only what the Filter menu offers this person, and
// checks the answer into the sheet's filters (server/filters/words.ts). Nothing is saved.
export async function filterWords(capId: string, sheetId: string, text: string) {
  const prep = await asAction(async (tx, ctx) => ({
    words: await filterWordsInput(tx, ctx, capId, sheetId, text),
    who: { workspaceId: ctx.workspaceId, personId: ctx.actor.id, capabilityId: capId },
  }));
  if (!prep.ok) return prep;
  return wordsToFilters(prep.words, prep.who);
}

// The record's related rows, notes and History (0.4, M22): kernel reads and one write as the signed-in person.
export async function rowRelated(rowId: string) {
  return asAction(async (tx, ctx) => ({ sheets: await relatedRows(tx, ctx, rowId) }));
}

export async function rowHistory(rowId: string) {
  return asAction(async (tx, ctx) => ({ items: await historyOf(tx, ctx, rowId) }));
}

export async function addRowNote(rowId: string, text: string) {
  return asAction(async (tx, ctx) => ({ id: (await addNote(tx, ctx, rowId, text)).id }));
}

// The capability's tutorial (0.4, M24): read, or written once for this person's access and read; and "Got it".
export async function tutorialOf(capId: string) {
  // Access is checked first, as the person: someone who can't see the capability gets the ordinary refusal.
  const prep = await asAction(async (tx, ctx) => (await tutorialState(tx, ctx, capId), { ctx }));
  if (!prep.ok) return prep;
  return tutorialFor(prep.ctx, capId);
}

export async function tutorialSeen(capId: string) {
  return asAction(async (tx, ctx) => (await closeTutorial(tx, ctx, capId), {}));
}
