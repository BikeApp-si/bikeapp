import type { CustomizeChange } from "./draft";
import { column, compileCapability, compileRule, finishColumn, step } from "../plans/compile";
import type { DraftRule } from "../plans/draft";
import { byName, capabilityId, newId, norm, personId, resolveExpr, type World } from "../plans/names";
import type { CapabilityFile, Rule, Sheet } from "../schema/file";
import { applyChanges, ChangeError, type Change } from "./changes";
import type { Edits } from "./apply";
import { usesOf, type Use } from "./deps";

// Prompt 3's changes, by name → kernel changes, by id (changes.ts). Every name is checked; problems come back
// in plain words for the AI's one retry. Renaming a step or column also rewrites the sentences of the rules
// that use it, in whichever capability they are, so the text keeps reading right (6h): ids don't change, so
// nothing else needs fixing. Pure: nothing here reads or writes the database.

export type CustomizeWorld = {
  capId: string;
  files: ReadonlyMap<string, CapabilityFile>;
  people: ReadonlyMap<string, string>; // work email (lowercase) → person id
};

export type Rename = { sheetId: string; stepId?: string; columnId?: string; from: string; to: string; insteadOfRemoval: boolean; uses: Use[] };

export type Compiled = {
  changes: Change[]; // in this capability, before its rules are written
  words: { explain: string; part: string; where: string }[]; // one per change prompt 3 asked for
  rules: { sentence: string; replaces: string | null }[]; // for the logic writer; replaces is a rule id
  renames: Rename[];
  problems: string[];
};

const planWorld = (w: CustomizeWorld, file: CapabilityFile): World => ({ newId: w.capId, newName: file.name, files: new Map([...w.files, [w.capId, file]]), people: w.people });

// Where a change shows in the text, for the Change / Where table (6c).
function whereOf(c: CustomizeChange, sheet: Sheet | undefined): string {
  switch (c.kind) {
    case "add_step":
    case "set_step_movers":
      return "Steps";
    case "rename":
      return c.rename?.what === "step" ? "Steps" : c.rename?.what === "capability" ? "Name" : `${sheet?.name ?? c.sheet ?? ""} sheet`;
    case "add_person_to_role":
    case "set_role_view":
    case "set_sheet_access":
      return "Who can see and do what";
    case "set_show_when":
      return `${sheet?.name ?? c.sheet ?? ""} sheet › ${c.show_when?.column ?? ""}`;
    case "rule":
      return "What happens by itself";
    case "add_sheet":
      return `${c.new_sheet?.name ?? ""} sheet`;
    case "set_form":
      return `${sheet?.name ?? c.sheet ?? ""} form`;
    case "link_column":
      return `${sheet?.name ?? c.sheet ?? ""} sheet › ${c.link?.column ?? ""}`;
    case "set_formula":
      return `${sheet?.name ?? c.sheet ?? ""} sheet › ${c.formula?.column ?? ""}`;
    default:
      return `${sheet?.name ?? c.sheet ?? ""} sheet`;
  }
}

export function compileCustomize(input: CustomizeChange[], w: CustomizeWorld): Compiled {
  const p: string[] = [];
  const out: Compiled = { changes: [], words: [], rules: [], renames: [], problems: p };
  // Each change is compiled against the file as the ones before it leave it, so a step added first can be
  // named by a later change.
  let file = w.files.get(w.capId)!;
  // A new sheet's computed columns come after the other changes (M28): its total can add up a column that a later
  // change adds elsewhere (Spent, the expenses that name a cost centre, through a link that can only come once the
  // sheet exists), or rows of its own sheet (Total spent, the cost centres under it).
  const later: { sheet: string; columns: NonNullable<CustomizeChange["new_sheet"]>["columns"] }[] = [];
  for (const c of input) {
    const sheet = c.sheet ? byName(file.sheets, c.sheet) : undefined;
    const where = `${file.name}${sheet ? ` › ${sheet.name}` : ""}`;
    const need = <T>(v: T | null | undefined, what: string): v is T => {
      if (v == null) p.push(`${where}: a ${c.kind.replaceAll("_", " ")} change needs its ${what}.`);
      return v != null;
    };
    if (c.sheet && !sheet && c.kind !== "add_sheet") {
      p.push(`${file.name} has no sheet “${c.sheet}”.`);
      continue;
    }
    const made: Change[] = [];
    const ids = (list: { id: string }[] | undefined) => new Set((list ?? []).map((x) => x.id));
    switch (c.kind) {
      case "add_sheet": {
        if (!need(c.new_sheet, "sheet")) break;
        // A title question named but not among the questions (a Contacts sheet titled by "Name", with no Name) is
        // added as text, first, rather than refused (C3: it cost the advisor a retry).
        const blankCol = { required: false, default: null, options: [], link: null, formula: null, result: null };
        let draft = c.new_sheet.columns.some((x) => norm(x.name) === norm(c.new_sheet!.title_column))
          ? c.new_sheet
          : { ...c.new_sheet, columns: [{ ...blankCol, name: c.new_sheet.title_column, type: "text" as const, required: true }, ...c.new_sheet.columns] };
        // Steps with no step question: its Status question becomes it, or a Status is added last (C3).
        if (draft.steps.length && !draft.columns.some((x) => x.type === "step")) {
          const status = draft.columns.find((x) => norm(x.name) === "status");
          draft = { ...draft, columns: status ? draft.columns.map((x) => (x === status ? { ...x, type: "step" as const, options: [] } : x)) : [...draft.columns, { ...blankCol, name: "Status", type: "step" as const }] };
        }
        const computed = draft.columns.filter((x) => x.type === "computed" && norm(x.name) !== norm(draft.title_column));
        if (computed.length) {
          later.push({ sheet: draft.name, columns: computed });
          draft = { ...draft, columns: draft.columns.filter((x) => !computed.includes(x)) };
        }
        // Compiled beside the sheets already here, so it can link to them.
        const temp = compileCapability({ name: file.name, icon: file.icon, sheets: [draft], roles: [], later: [] }, planWorld(w, file), p, file);
        made.push({ kind: "add_sheet", sheet: temp.sheets.at(-1)! });
        break;
      }
      case "add_column": {
        if (!need(sheet, "sheet") || !need(c.column, "column")) break;
        const col = column(c.column, newId(c.column.name, ids(sheet.columns)));
        // Read beside itself, so a tree's total can add up its own column on the rows under it (Total spent, M29:
        // the planner added it as its own change); a total that reads itself in a circle is refused by validateFile.
        const withCol = { ...sheet, columns: [...sheet.columns, col] };
        const beside = { ...file, sheets: file.sheets.map((s) => (s.id === sheet.id ? withCol : s)) };
        finishColumn(planWorld(w, beside), w.capId, withCol, col, c.column, p);
        made.push({ kind: "add_column", sheet: sheet.id, column: col });
        break;
      }
      case "add_step": {
        if (!need(sheet, "sheet") || !need(c.step, "step")) break;
        const after = byName(sheet.steps, c.after);
        if (!after) {
          p.push(`${where}: there is no step “${c.after ?? ""}” to add it after.`);
          break;
        }
        const st = step({ ...c.step, start: false }, newId(c.step.name, ids(sheet.steps)));
        if (c.step.only_when) st.onlyWhen = resolveExpr(c.step.only_when, { world: planWorld(w, file), capId: w.capId, sheet, problems: p, where: `${where} › ${st.name}` });
        made.push({ kind: "add_step", sheet: sheet.id, after: after.id, step: st });
        break;
      }
      case "rename": {
        if (!need(c.rename, "names")) break;
        const r = c.rename;
        if (r.what === "capability") {
          made.push({ kind: "rename", name: r.to.trim() });
          break;
        }
        const on = sheet ?? file.sheets.find((s) => (r.what === "sheet" ? byName([s], r.from) : r.what === "step" ? byName(s.steps, r.from) : byName(s.columns, r.from)));
        if (!on) {
          p.push(`${file.name} has no ${r.what} “${r.from}”.`);
          break;
        }
        if (r.what === "sheet") made.push({ kind: "rename", sheet: on.id, name: r.to.trim() });
        else {
          const target = r.what === "step" ? byName(on.steps, r.from) : byName(on.columns, r.from);
          if (!target) {
            p.push(`${on.name} has no ${r.what} “${r.from}”.`);
            break;
          }
          made.push({ kind: "rename", sheet: on.id, [r.what]: target.id, name: r.to.trim() });
          const t = { capabilityId: w.capId, sheetId: on.id, ...(r.what === "step" ? { step: target.id } : { column: target.id }) } as Parameters<typeof usesOf>[1];
          out.renames.push({ sheetId: on.id, ...(r.what === "step" ? { stepId: target.id } : { columnId: target.id }), from: target.name, to: r.to.trim(), insteadOfRemoval: r.instead_of_removal, uses: usesOf(new Map([...w.files, [w.capId, file]]), t) });
        }
        break;
      }
      case "set_step_movers": {
        if (!need(sheet, "sheet") || !need(c.movers, "step")) break;
        const st = byName(sheet.steps, c.movers.step);
        if (!st) p.push(`${where}: there is no step “${c.movers.step}”.`);
        else made.push({ kind: "set_step_movers", sheet: sheet.id, step: st.id, moveOut: c.movers.move_out, moveIn: c.movers.move_in });
        break;
      }
      case "add_person_to_role": {
        const role = byName(file.roles, c.role);
        const person = personId(planWorld(w, file), c.person);
        if (!role) p.push(`${file.name} has no role “${c.role ?? ""}”.`);
        else if (!person) p.push(`${c.person ?? "That person"} isn't in People.`);
        else made.push({ kind: "add_person_to_role", role: role.id, person });
        break;
      }
      case "rule": {
        if (!need(c.rule, "sentence")) break;
        const replaced = c.rule.replaces ? file.rules.find((r) => norm(r.text) === norm(c.rule!.replaces!)) : undefined;
        if (c.rule.replaces && !replaced) p.push(`${file.name} has no rule “${c.rule.replaces}”.`);
        out.rules.push({ sentence: c.rule.sentence, replaces: replaced?.id ?? null });
        break;
      }
      case "set_role_view": {
        const role = byName(file.roles, c.role);
        if (!role || !need(c.view, "view")) {
          if (!role) p.push(`${file.name} has no role “${c.role ?? ""}”.`);
          break;
        }
        const on = file.sheets.find((s) => s.id === role.view?.sheet) ?? sheet ?? file.sheets.find((s) => !role.sheets || role.sheets.includes(s.id))!;
        const colId = (n: string) => byName(on.columns, n)?.id ?? (p.push(`${on.name} has no column “${n}”.`), n);
        made.push({
          kind: "set_role_view",
          role: role.id,
          view: { ...(role.view ?? {}), sheet: on.id, line: c.view.line.trim(), columns: c.view.columns.map((n) => ({ column: colId(n) })), ...(c.view.form ? { form: c.view.form.map(colId) } : {}) },
        });
        break;
      }
      case "set_labels": {
        if (!need(sheet, "sheet") || !need(c.labels, "labels")) break;
        const l = c.labels;
        const buttons = Object.fromEntries(l.buttons.flatMap((b) => {
          const st = byName(sheet.steps, b.step);
          if (!st) p.push(`${where}: there is no step “${b.step}”.`);
          return st ? [[st.id, b.button.trim()]] : [];
        }));
        made.push({
          kind: "set_labels",
          sheet: sheet.id,
          ...(l.row_one && l.row_many ? { row: { one: l.row_one.trim(), many: l.row_many.trim() } } : {}),
          ...(l.add_action ? { addAction: l.add_action.trim() } : {}),
          ...(Object.keys(buttons).length ? { buttons } : {}),
        });
        break;
      }
      case "set_hint_column": {
        if (!need(sheet, "sheet") || !need(c.hint, "column")) break;
        const col = byName(sheet.columns, c.hint.column);
        const beside = c.hint.beside ? byName(sheet.columns, c.hint.beside) : null;
        if (!col || (c.hint.beside && !beside)) p.push(`${where}: there is no column “${!col ? c.hint.column : c.hint.beside}”.`);
        else made.push({ kind: "set_hint_column", sheet: sheet.id, column: col.id, hintFor: beside?.id ?? null });
        break;
      }
      case "set_default_sort": {
        if (!need(sheet, "sheet") || !need(c.sort, "column")) break;
        const col = byName(sheet.columns, c.sort.column);
        if (!col) p.push(`${where}: there is no column “${c.sort.column}”.`);
        else made.push({ kind: "set_default_sort", sheet: sheet.id, sort: { column: col.id, dir: c.sort.dir } });
        break;
      }
      case "add_sheet_check": {
        if (!need(sheet, "sheet") || !need(c.check, "check")) break;
        const condition = resolveExpr(c.check.condition, { world: planWorld(w, file), capId: w.capId, sheet, problems: p, where: `${where} › ${c.check.name}` });
        made.push({ kind: "add_sheet_check", sheet: sheet.id, check: { id: newId(c.check.name, ids(sheet.checks)), name: c.check.name.trim(), condition } });
        break;
      }
      // 0.3: the form, by question names; a question named twice or not at all is a plain problem.
      case "set_form": {
        if (!need(sheet, "sheet") || !need(c.form, "form")) break;
        const idOf = (n: string) => {
          const col = byName(sheet.columns, n);
          if (!col) p.push(`${where}: there is no question “${n}”.`);
          return col?.id;
        };
        const tabs = c.form.tabs.map((t) => ({
          name: t.name.trim(),
          sections: t.sections.map((s) => ({ name: s.name?.trim() || null, columns: s.columns.map(idOf).filter((x): x is string => !!x) })),
        }));
        const quick = c.form.quick === null ? sheet.form?.quick : c.form.quick.map(idOf).filter((x): x is string => !!x);
        made.push({ kind: "set_form", sheet: sheet.id, form: tabs.length ? { tabs, ...(quick?.length ? { quick } : {}) } : null });
        break;
      }
      case "set_show_when": {
        if (!need(sheet, "sheet") || !need(c.show_when, "question")) break;
        const col = byName(sheet.columns, c.show_when.column);
        if (!col) {
          p.push(`${where}: there is no question “${c.show_when.column}”.`);
          break;
        }
        const showWhen = c.show_when.condition === null ? null : resolveExpr(c.show_when.condition, { world: planWorld(w, file), capId: w.capId, sheet, problems: p, where: `${where} › ${col.name}` });
        made.push({ kind: "set_show_when", sheet: sheet.id, column: col.id, showWhen });
        break;
      }
      case "set_formula": {
        if (!need(sheet, "sheet") || !need(c.formula, "formula")) break;
        const col = byName(sheet.columns, c.formula.column);
        if (!col || col.type !== "computed") {
          p.push(`${where}: ${col ? `${col.name} is answered, not worked out, so it has no formula to change` : `there is no question “${c.formula.column}”`}.`);
          break;
        }
        const expr = resolveExpr(c.formula.formula, { world: planWorld(w, file), capId: w.capId, sheet, problems: p, where: `${where} › ${col.name}` });
        made.push({ kind: "set_formula", sheet: sheet.id, column: col.id, expr });
        break;
      }
      case "link_column": {
        if (!need(sheet, "sheet") || !need(c.link, "link")) break;
        const col = byName(sheet.columns, c.link.column);
        const toCap = capabilityId(planWorld(w, file), c.link.to_capability, w.capId);
        const toFile = toCap ? (toCap === w.capId ? file : w.files.get(toCap)) : undefined;
        const toSheet = byName(toFile?.sheets, c.link.to_sheet);
        if (!col) p.push(`${where} has no column “${c.link.column}”.`);
        else if (!toFile || !toSheet) p.push(`There is no sheet “${c.link.to_sheet}”${c.link.to_capability ? ` in ${c.link.to_capability}` : ""} to link to.`);
        else made.push({ kind: "link_column", sheet: sheet.id, column: col.id, to: { ...(toCap !== w.capId ? { capability: toCap! } : {}), sheet: toSheet.id } });
        break;
      }
      case "set_sheet_access": {
        if (!need(sheet, "sheet") || !need(c.access, "access")) break;
        const role = byName(file.roles, c.role);
        if (!role) {
          p.push(`${file.name} has no role “${c.role ?? ""}”.`);
          break;
        }
        const a = c.access;
        if (a.sees === "all" || a.sees === "none") {
          made.push({ kind: "set_sheet_access", role: role.id, sheet: sheet.id, sees: a.sees });
          break;
        }
        const via = a.sees === "through_link" ? byName(sheet.columns, a.via) : undefined;
        if (a.sees === "through_link" && (via?.type !== "link" || !via.link || via.link.capability)) {
          p.push(`${where}: “${a.via ?? ""}” isn't a link to another sheet of ${file.name}.`);
          break;
        }
        const on = via ? file.sheets.find((s) => s.id === via.link!.sheet) : sheet;
        const col = on ? byName(on.columns, a.column) : undefined;
        if (col?.type !== "person") {
          p.push(`${on?.name ?? sheet.name} has no person column “${a.column ?? ""}” that says whose a row is.`);
          break;
        }
        made.push(via ? { kind: "set_sheet_access", role: role.id, sheet: sheet.id, sees: "through_link", via: via.id, column: col.id } : { kind: "set_sheet_access", role: role.id, sheet: sheet.id, sees: "by_column", column: col.id });
        break;
      }
    }
    try {
      file = applyChanges(file, made);
      out.changes.push(...made);
    } catch (e) {
      if (!(e instanceof ChangeError)) throw e;
      p.push(e.message);
    }
    out.words.push({ explain: c.explain.trim(), part: c.part.trim(), where: whereOf(c, sheet) });
  }
  for (const l of later) {
    const sheet = byName(file.sheets, l.sheet);
    if (!sheet) continue;
    const taken = new Set(sheet.columns.map((x) => x.id));
    const cols = l.columns.map((d) => column(d, newId(d.name, taken)));
    // Every one of them is there while their formulas are read, so a total can add up its own column.
    const withThem = { ...sheet, columns: [...sheet.columns, ...cols] };
    const world = planWorld(w, { ...file, sheets: file.sheets.map((x) => (x.id === sheet.id ? withThem : x)) });
    l.columns.forEach((d, i) => finishColumn(world, w.capId, withThem, cols[i]!, d, p));
    const made: Change[] = cols.map((col) => ({ kind: "add_column", sheet: sheet.id, column: col }));
    try {
      file = applyChanges(file, made);
      out.changes.push(...made);
    } catch (e) {
      if (!(e instanceof ChangeError)) throw e;
      p.push(e.message);
    }
  }
  return out;
}

// The logic writer's rules for the sentences, as changes: a replacement keeps the id of the rule it replaces.
export function ruleChanges(compiled: Compiled, drafts: DraftRule[], w: CustomizeWorld): { changes: { kind: "set_rule"; rule: Rule }[]; problems: string[] } {
  const p: string[] = [];
  let file: CapabilityFile;
  try {
    file = applyChanges(w.files.get(w.capId)!, compiled.changes);
  } catch (e) {
    if (!(e instanceof ChangeError)) throw e;
    return { changes: [], problems: [e.message] };
  }
  const taken = new Set(file.rules.map((r) => r.id));
  const changes: { kind: "set_rule"; rule: Rule }[] = [];
  for (const d of drafts) {
    const made = compileRule(d, planWorld(w, file), taken, p);
    if (!made) continue;
    if (made.capId !== w.capId) {
      p.push(`Rule “${d.text}”: starts in another app; change it in that app's Customize.`);
      continue;
    }
    const replaces = compiled.rules.find((r) => norm(r.sentence) === norm(d.text))?.replaces;
    changes.push({ kind: "set_rule", rule: replaces ? { ...made.rule, id: replaces } : made.rule });
  }
  return { changes, problems: p };
}

// The change set, or what stops it, in words: a change that can't be applied is a problem for the AI's retry and
// the person's reply, never an error that ends the chat (found live on Nov 3: "Budgets already has a column
// “spent”." escaped and the admin read "I couldn't do that").
export function tryEdits(w: CustomizeWorld, changes: Change[], compiled: Compiled): { edits: Edits; problems: [] } | { edits: null; problems: string[] } {
  try {
    return { edits: editsOf(w, changes, compiled), problems: [] };
  } catch (e) {
    if (!(e instanceof ChangeError)) throw e;
    console.warn(`Customize: a change couldn't be applied to ${w.files.get(w.capId)?.name ?? w.capId}: ${e.message} (${changes.map((c) => c.kind).join(", ")})`);
    return { edits: null, problems: [e.message] };
  }
}

const renamedIn = (text: string, from: string, to: string) => text.replace(new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), to);

// The change set: this capability's changes, and the rules elsewhere whose sentences name what was renamed.
export function editsOf(w: CustomizeWorld, changes: Change[], compiled: Compiled): Edits {
  const before = w.files.get(w.capId)!;
  const per = new Map<string, Change[]>([[w.capId, [...changes]]]);
  const main = applyChanges(before, changes);
  for (const r of compiled.renames)
    for (const u of r.uses) {
      if (!u.ruleId) continue;
      const rule = (u.capabilityId === w.capId ? main : w.files.get(u.capabilityId)!).rules.find((x) => x.id === u.ruleId);
      if (!rule) continue;
      const fixed: Rule = { ...rule, text: renamedIn(rule.text, r.from, r.to), reading: { when: renamedIn(rule.reading.when, r.from, r.to), then: renamedIn(rule.reading.then, r.from, r.to) } };
      if (fixed.text !== rule.text || fixed.reading.when !== rule.reading.when || fixed.reading.then !== rule.reading.then)
        per.set(u.capabilityId, [...(per.get(u.capabilityId) ?? []), { kind: "set_rule", rule: fixed }]);
    }
  const words = compiled.words.map((x) => x.explain);
  return new Map(
    [...per].map(([id, list]) => {
      const was = w.files.get(id)!;
      return [id, { before: was, after: applyChanges(was, list), changes: id === w.capId ? words : list.map((c) => (c.kind === "set_rule" ? `Rule reworded: “${c.rule.text}”` : c.kind)) }];
    }),
  );
}
