import { columnsUsed } from "./expr/ast";
import type { World } from "./customize/check";
import { ruleReads } from "./customize/deps";
import { keptByKernel, type CapabilityFile, type Sheet } from "./schema/file";

// A row's form (0.3): the questions asked when a row is added, and the record's tabs. The kernel works out which
// questions must be asked at creation, so a check or a rule never runs on a new row without what it reads.

export type FormTab = { name: string; sections: { name: string | null; columns: string[] }[] };

const fillable = (sheet: Sheet) => sheet.columns.filter((c) => c.type !== "computed" && c.type !== "step" && !c.hintFor).map((c) => c.id);

// The record's tabs: the sheet's own, or one "Details" tab in sheet order. A question the tabs leave out goes in the
// last one, so nothing can't be filled in.
export function tabsOf(sheet: Sheet): FormTab[] {
  const all = fillable(sheet);
  if (!sheet.form) return [{ name: "Details", sections: [{ name: null, columns: all }] }];
  const tabs = sheet.form.tabs.map((t) => ({ name: t.name, sections: t.sections.map((s) => ({ name: s.name, columns: s.columns.filter((id) => all.includes(id)) })) }));
  const placed = new Set(tabs.flatMap((t) => t.sections.flatMap((s) => s.columns)));
  const rest = all.filter((id) => !placed.has(id));
  if (rest.length) tabs.at(-1)!.sections.push({ name: null, columns: rest });
  return tabs;
}

// The questions asked when a row is added, in sheet order: the title, every required question, what the sheet's
// checks and its rules for a new row read, and the ones the form adds. Every question, when a new row goes to someone
// (a rule asks a person as soon as it is added): a request is never sent half-filled.
export function quickOf(file: CapabilityFile, capId: string, sheet: Sheet, world: World): string[] {
  const all = fillable(sheet);
  const start = sheet.steps?.find((s) => s.start)?.id;
  const onNew = file.rules.filter(
    (r) => r.trigger.sheet === sheet.id && (r.trigger.kind === "row_created" || (r.trigger.kind === "enters_step" && !!start && r.trigger.step === start)),
  );
  if (onNew.some((r) => r.actions.some((a) => a.kind === "ask_person"))) return all;
  const read = new Set<string>([sheet.titleColumn, ...(sheet.form?.quick ?? []), ...(sheet.checks ?? []).flatMap((c) => columnsUsed(c.condition))]);
  for (const c of sheet.columns) {
    if (c.required) read.add(c.id);
    if (onNew.some((r) => ruleReads(r, capId, { capabilityId: capId, sheetId: sheet.id, column: c.id }, world))) read.add(c.id);
  }
  // A column kept from before (M27) is read only, so it is never asked.
  // Nor is a column the kernel fills (a ledger's balance and reversal, M29).
  const kept = new Set(sheet.columns.filter((c) => c.replacedBy || keptByKernel(sheet, c.id)).map((c) => c.id));
  return all.filter((id) => read.has(id) && !kept.has(id));
}

// Tabs for a new capability's sheet (0.3), from a fixed rule so a plan and Build all give the same ones every time:
// Basics, then Dates when there are two or more, then Documents for files. A sheet with fewer than 7 questions, or
// only one tab's worth, gets none. Renamed or rearranged afterwards through Customize.
export function defaultForm(sheet: Sheet): Sheet["form"] | undefined {
  const all = sheet.columns.filter((c) => c.type !== "computed" && c.type !== "step" && !c.hintFor && !c.replacedBy && !keptByKernel(sheet, c.id));
  if (all.length < 7) return undefined;
  const optional = all.filter((c) => c.id !== sheet.titleColumn && !c.required);
  const dated = optional.filter((c) => c.type === "date" || c.type === "datetime");
  const dates = dated.length >= 2 ? optional.filter((c) => c.type === "date" || c.type === "datetime" || c.type === "days") : [];
  const files = optional.filter((c) => c.type === "file");
  const basics = all.filter((c) => !dates.includes(c) && !files.includes(c));
  const tabs = [
    { name: "Basics", columns: basics },
    { name: "Dates", columns: dates },
    { name: "Documents", columns: files },
  ].filter((t) => t.columns.length);
  if (tabs.length < 2) return undefined;
  return { tabs: tabs.map((t) => ({ name: t.name, sections: [{ name: null, columns: t.columns.map((c) => c.id) }] })) };
}
