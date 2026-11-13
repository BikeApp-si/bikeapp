import { newId } from "../plans/names";
import type { CapabilityFile, Column } from "../schema/file";

// M27: a typed text column turned into a link, as a file change. Pure, so Customize's changes and a plan's Also
// changes share it; the rows are moved by the kernel on Apply (move.ts).

export class LinkError extends Error {}

export type LinkInstead = { sheet: string; column: string; to: { capability?: string; sheet: string } };

// What the kept column is called once its link takes its name.
export const keptName = (name: string) => `${name}, as typed`;

// The file change, pure: the link takes the typed column's name, place, required and title; the typed column
// stays, renamed and read only, out of forms, sorts and role views (the link takes its place there too).
export function linkInstead(file: CapabilityFile, c: LinkInstead): CapabilityFile {
  const out = structuredClone(file);
  const sheet = out.sheets.find((s) => s.id === c.sheet);
  if (!sheet) throw new LinkError(`${file.name} has no sheet “${c.sheet}”.`);
  const old = sheet.columns.find((x) => x.id === c.column);
  if (!old) throw new LinkError(`${sheet.name} has no column “${c.column}”.`);
  if (old.type !== "text") throw new LinkError(`${sheet.name} › ${old.name} isn't typed text, so it can't become a link.`);
  if (old.replacedBy) throw new LinkError(`${sheet.name} › ${old.name} is already kept from before.`);
  const id = newId(old.name, new Set(sheet.columns.map((x) => x.id)));
  const link: Column = { id, name: old.name, type: "link", link: { ...(c.to.capability ? { capability: c.to.capability } : {}), sheet: c.to.sheet } };
  if (old.required) link.required = true;
  // The link in its place; the kept column last, after the step, as the table shows it (m27-d).
  sheet.columns.splice(sheet.columns.indexOf(old), 1, link);
  sheet.columns.push(old);
  old.name = keptName(old.name);
  old.replacedBy = id;
  delete old.required;
  delete old.default;
  delete old.showWhen;
  const swap = (x: string) => (x === old.id ? id : x);
  if (sheet.titleColumn === old.id) sheet.titleColumn = id;
  if (sheet.sort) {
    sheet.sort.column = swap(sheet.sort.column);
    if (sheet.sort.then) sheet.sort.then.column = swap(sheet.sort.then.column);
  }
  if (sheet.form) {
    for (const t of sheet.form.tabs) for (const s of t.sections) s.columns = s.columns.map(swap);
    if (sheet.form.quick) sheet.form.quick = sheet.form.quick.map(swap);
  }
  for (const r of out.roles) {
    if (r.view?.sheet !== sheet.id) continue;
    for (const vc of r.view.columns) {
      vc.column = swap(vc.column);
      if (vc.hint) vc.hint = swap(vc.hint);
    }
    if (r.view.form) r.view.form = r.view.form.map((f) => (Array.isArray(f) ? [swap(f[0]), swap(f[1])] : swap(f))) as typeof r.view.form;
  }
  return out;
}

export type Move = { capabilityId: string; sheet: string; from: string; to: string };

// The moves a new version asks for: every column that is kept from before in `after` and wasn't in `before`.
export function movesOf(capabilityId: string, before: CapabilityFile | null, after: CapabilityFile): Move[] {
  const out: Move[] = [];
  for (const s of after.sheets)
    for (const c of s.columns) {
      if (!c.replacedBy) continue;
      const was = before?.sheets.find((x) => x.id === s.id)?.columns.find((x) => x.id === c.id);
      if (!was?.replacedBy) out.push({ capabilityId, sheet: s.id, from: c.id, to: c.replacedBy });
    }
  return out;
}
