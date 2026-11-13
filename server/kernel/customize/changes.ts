import type { z } from "zod";
import type { Expr } from "../expr/ast";
import type { CapabilityFile, checkSchema, Column, Mover, Rule, Sheet, Step, viewSchema } from "../schema/file";
import { LinkError, linkInstead, type LinkInstead } from "./link-instead";
import { AccessChangeError, defaultAccess, setSheetAccess, type SheetAccess } from "./sheet-access";

// A Customize change, by ids, as the kernel applies it to a capability file (6c–6l). Prompt 3 says what to
// change in names; compile.ts turns that into these. Each one only adds or renames, so no row moves: rows keep
// their column and step ids, and a rename changes a name only. The one exception (M27): link_column, a typed
// column turned into a link, whose rows the kernel moves on Apply (move.ts).

type View = z.infer<typeof viewSchema>;
type Check = z.infer<typeof checkSchema>;
type Sort = NonNullable<Sheet["sort"]>;

export type Change =
  | { kind: "add_sheet"; sheet: Sheet }
  | { kind: "add_column"; sheet: string; column: Column; after?: string }
  | { kind: "add_step"; sheet: string; step: Step; after: string }
  // Nothing named: the capability itself.
  | { kind: "rename"; sheet?: string; column?: string; step?: string; name: string }
  | { kind: "set_step_movers"; sheet: string; step: string; moveOut?: Mover; moveIn?: Mover }
  | { kind: "add_person_to_role"; role: string; person: string }
  // A rule added, or one with the same id replaced (prompt 4 writes it).
  | { kind: "set_rule"; rule: Rule }
  | { kind: "set_role_view"; role: string; view: View }
  | { kind: "set_labels"; sheet: string; row?: { one: string; many: string }; addAction?: string; buttons?: Record<string, string> }
  | { kind: "set_hint_column"; sheet: string; column: string; hintFor: string | null }
  | { kind: "set_default_sort"; sheet: string; sort: Sort | null }
  | { kind: "add_sheet_check"; sheet: string; check: Check }
  // 0.3: the sheet's form (null: none, one Details tab), and a question shown only sometimes (null: always).
  | { kind: "set_form"; sheet: string; form: Sheet["form"] | null }
  | { kind: "set_show_when"; sheet: string; column: string; showWhen: Expr | null }
  // M29: a computed column's formula written again; its values are worked out again on Apply (fillNewComputed).
  | { kind: "set_formula"; sheet: string; column: string; expr: Expr }
  // C1: who sees a sheet's rows, per role (sheet-access.ts).
  | ({ kind: "set_sheet_access" } & SheetAccess)
  // M27: a typed column becomes a link to another sheet; the typed values are kept, read only.
  | ({ kind: "link_column" } & LinkInstead);

export class ChangeError extends Error {}

function sheetOf(file: CapabilityFile, id: string): Sheet {
  const s = file.sheets.find((x) => x.id === id);
  if (!s) throw new ChangeError(`${file.name} has no sheet “${id}”.`);
  return s;
}

function stepOf(sheet: Sheet, id: string): Step {
  const s = sheet.steps?.find((x) => x.id === id);
  if (!s) throw new ChangeError(`${sheet.name} has no step “${id}”.`);
  return s;
}

function columnOf(sheet: Sheet, id: string): Column {
  const c = sheet.columns.find((x) => x.id === id);
  if (!c) throw new ChangeError(`${sheet.name} has no column “${id}”.`);
  return c;
}

function roleOf(file: CapabilityFile, id: string) {
  const r = file.roles.find((x) => x.id === id);
  if (!r) throw new ChangeError(`${file.name} has no role “${id}”.`);
  return r;
}

function applyOne(file: CapabilityFile, c: Change): void {
  switch (c.kind) {
    case "add_sheet":
      if (file.sheets.some((s) => s.id === c.sheet.id)) throw new ChangeError(`${file.name} already has a sheet “${c.sheet.id}”.`);
      file.sheets.push(c.sheet);
      // Roles that see only some rows get a way to see the new sheet's, or leave it to admins (C1).
      defaultAccess(file, c.sheet);
      return;
    case "add_column": {
      const sheet = sheetOf(file, c.sheet);
      if (sheet.columns.some((x) => x.id === c.column.id)) throw new ChangeError(`${sheet.name} already has a column “${c.column.id}”.`);
      // Before the step column when no place is named, so the step stays last as the tables show it.
      const at = c.after ? sheet.columns.indexOf(columnOf(sheet, c.after)) + 1 : sheet.columns.findIndex((x) => x.type === "step");
      sheet.columns.splice(at < 0 ? sheet.columns.length : at, 0, c.column);
      return;
    }
    case "add_step": {
      const sheet = sheetOf(file, c.sheet);
      if (sheet.steps?.some((x) => x.id === c.step.id)) throw new ChangeError(`${sheet.name} already has a step “${c.step.id}”.`);
      const after = stepOf(sheet, c.after);
      sheet.steps!.splice(sheet.steps!.indexOf(after) + 1, 0, c.step);
      return;
    }
    case "rename": {
      if (!c.sheet) {
        file.name = c.name;
        return;
      }
      const sheet = sheetOf(file, c.sheet);
      if (c.step) stepOf(sheet, c.step).name = c.name;
      else if (c.column) columnOf(sheet, c.column).name = c.name;
      else sheet.name = c.name;
      return;
    }
    case "set_step_movers": {
      const step = stepOf(sheetOf(file, c.sheet), c.step);
      for (const k of ["moveOut", "moveIn"] as const) {
        if (!c[k]) continue;
        if (c[k] === "anyone") delete step[k];
        else step[k] = c[k];
      }
      return;
    }
    case "add_person_to_role": {
      const role = roleOf(file, c.role);
      if (role.members.kind !== "people") throw new ChangeError(`${role.name} is whoever a column names, so nobody is added to it by name.`);
      if (!role.members.people.includes(c.person)) role.members.people.push(c.person);
      return;
    }
    case "set_rule": {
      const i = file.rules.findIndex((r) => r.id === c.rule.id);
      if (i >= 0) file.rules[i] = c.rule;
      else file.rules.push(c.rule);
      return;
    }
    case "set_role_view":
      roleOf(file, c.role).view = c.view;
      return;
    case "set_labels": {
      const sheet = sheetOf(file, c.sheet);
      if (c.row) sheet.row = c.row;
      if (c.addAction) sheet.addAction = c.addAction;
      for (const [id, button] of Object.entries(c.buttons ?? {})) stepOf(sheet, id).button = button;
      return;
    }
    case "set_hint_column": {
      const col = columnOf(sheetOf(file, c.sheet), c.column);
      if (c.hintFor) col.hintFor = c.hintFor;
      else delete col.hintFor;
      return;
    }
    case "set_default_sort": {
      const sheet = sheetOf(file, c.sheet);
      if (c.sort) sheet.sort = c.sort;
      else delete sheet.sort;
      return;
    }
    case "add_sheet_check": {
      const sheet = sheetOf(file, c.sheet);
      if (sheet.checks?.some((x) => x.id === c.check.id)) throw new ChangeError(`${sheet.name} already has a check “${c.check.id}”.`);
      sheet.checks = [...(sheet.checks ?? []), c.check];
      return;
    }
    case "set_form": {
      const sheet = sheetOf(file, c.sheet);
      for (const id of [...(c.form?.tabs.flatMap((t) => t.sections.flatMap((s) => s.columns)) ?? []), ...(c.form?.quick ?? [])]) columnOf(sheet, id);
      if (c.form) sheet.form = c.form;
      else delete sheet.form;
      return;
    }
    case "set_show_when": {
      const col = columnOf(sheetOf(file, c.sheet), c.column);
      if (c.showWhen) col.showWhen = c.showWhen;
      else delete col.showWhen;
      return;
    }
    case "set_formula": {
      const col = columnOf(sheetOf(file, c.sheet), c.column);
      if (col.type !== "computed") throw new ChangeError(`${col.name} is answered, not worked out, so it has no formula to change.`);
      col.expr = c.expr;
      return;
    }
    case "link_column": {
      try {
        const out = linkInstead(file, c);
        file.sheets = out.sheets;
        file.roles = out.roles;
      } catch (e) {
        if (e instanceof LinkError) throw new ChangeError(e.message);
        throw e;
      }
      return;
    }
    case "set_sheet_access": {
      const { kind: _kind, ...access } = c;
      try {
        setSheetAccess(file, access);
      } catch (e) {
        if (e instanceof AccessChangeError) throw new ChangeError(e.message);
        throw e;
      }
      return;
    }
  }
}

// The file as the changes leave it. Neither the file nor the changes passed in are ever changed: each change is
// copied first, so a sheet or column it adds is the file's own and a later change to it can't reach back into the
// change (found on Nov 3: the same changes applied twice failed with "already has a column"). Pure: the same file
// and changes always give the same result.
export function applyChanges(file: CapabilityFile, changes: readonly Change[]): CapabilityFile {
  const out = structuredClone(file);
  for (const c of changes) applyOne(out, structuredClone(c));
  return out;
}
