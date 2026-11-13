import { renderExpr } from "../expr/render";
import { describeCapability } from "../plans/structure";
import type { CapabilityFile } from "../schema/file";
import { quickOf, tabsOf } from "../form";
import { seeingWords } from "./sheet-access";
import type { Role, Sheet } from "../schema/file";

// The role beside this one that sees this sheet for it, if it's on.
const besideOn = (f: CapabilityFile, r: Role, s: Sheet) => f.roles.find((b) => b.beside?.role === r.id && b.beside.sheet === s.id && b.sheets?.includes(s.id));

// What prompt 3 and the suggestions are told about one capability: its structure by name (as prompt 2 sees
// it), plus what Customize can change that the structure leaves out: who is in each role and what they see,
// labels, sorts, checks and who may move each step. Names only, never ids; the same file gives the same text.

type Files = ReadonlyMap<string, CapabilityFile>;

// withForm: the form and its conditions (prompt 3 from 0.3); withAccess: how each role sees each sheet's rows
// (prompt 3 from C1). The suggestions prompt reads it without either.
export function customizeDescription(capId: string, files: Files, personName: (id: string) => string | undefined, opts: { withForm?: boolean; withAccess?: boolean } = {}): Record<string, unknown> {
  const f = files.get(capId)!;
  const base = describeCapability(capId, files, personName);
  const colName = (sheetId: string, id: string) => f.sheets.find((s) => s.id === sheetId)?.columns.find((c) => c.id === id)?.name ?? id;
  return {
    ...base,
    sheets: f.sheets.map((s, i) => ({
      ...(base.sheets as Record<string, unknown>[])[i],
      row: s.row ? `${s.row.one} / ${s.row.many}` : null,
      add_action: s.addAction ?? null,
      sort: s.sort ? `${colName(s.id, s.sort.column)} ${s.sort.dir === "asc" ? "ascending" : "descending"}` : null,
      checks: (s.checks ?? []).map((c) => c.name),
      // 0.3: the form as people fill it in, and the questions shown only sometimes.
      ...(opts.withForm
        ? {
          form: {
            tabs: tabsOf(s).map((t) => ({ name: t.name, sections: t.sections.map((x) => ({ name: x.name, questions: x.columns.map((id) => colName(s.id, id)) })) })),
            asked_when_adding: quickOf(f, capId, s, new Map([...files].map(([id, x]) => [id, x] as const))).map((id) => colName(s.id, id)),
          },
          shown_only_when: Object.fromEntries(
            s.columns.filter((c) => c.showWhen).map((c) => [c.name, renderExpr(c.showWhen!, { column: (id) => s.columns.find((x) => x.id === id), otherColumn: () => ({ sheet: "", column: "" }) })]),
          ),
          }
        : {}),
      steps_detail: (s.steps ?? []).map((st) => ({
        name: st.name,
        ...(st.onlyWhen !== undefined ? { only_when: renderExpr(st.onlyWhen, { column: (id) => s.columns.find((c) => c.id === id), otherColumn: () => ({ sheet: "", column: "" }) }) } : {}),
        ...(st.button ? { button: st.button } : {}),
        move_out: st.moveOut ?? "anyone",
        move_in: st.moveIn ?? "anyone",
      })),
    })),
    // A role beside another isn't a role of its own to the AI: its role says how it sees that sheet.
    roles: f.roles.filter((r) => !r.beside).map((r) => ({
      name: r.name,
      members:
        r.members.kind === "everyone" ? "everyone" : r.members.kind === "column" ? `whoever ${colName(r.members.sheet, r.members.column)} names` : r.members.people.map((p) => personName(p) ?? "someone"),
      can: r.can,
      rows: r.scope === "all" ? "every row" : r.scope === "own" ? "their own rows" : "their team's rows",
      ...(r.sheets ? { sheets: r.sheets.map((id) => f.sheets.find((s) => s.id === id)?.name ?? id) } : {}),
      ...(r.view ? { view: { line: r.view.line, columns: r.view.columns.map((c) => colName(r.view!.sheet, c.column)) } } : {}),
      ...(opts.withAccess ? { sees: Object.fromEntries(f.sheets.filter((s) => s.kind !== "lines").map((s) => [s.name, seeingWords(f, besideOn(f, r, s) ?? r, s)])) } : {}),
    })),
  };
}
