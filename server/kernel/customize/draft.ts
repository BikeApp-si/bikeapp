import { z } from "zod";
import { draftColumn, draftSheet, draftStep } from "../plans/draft";
import { MOVERS } from "../schema/file";

// A Customize change as prompt 3 writes it: everything by name, never by id, every field present (null or
// empty when unused). compile.ts turns it into kernel changes (changes.ts), checking every name.

const name = z.string().min(1).max(80);

export const CHANGE_KINDS = [
  "add_sheet",
  "add_column",
  "add_step",
  "rename",
  "set_step_movers",
  "add_person_to_role",
  "rule",
  "set_role_view",
  "set_labels",
  "set_hint_column",
  "set_default_sort",
  "add_sheet_check",
  "set_form",
  "set_show_when",
  "set_sheet_access",
  "link_column",
  "set_formula",
] as const;

export const customizeChange = z.object({
  kind: z.enum(CHANGE_KINDS),
  sheet: name.nullable(), // the sheet it changes, when it changes one
  new_sheet: draftSheet.nullable(), // add_sheet
  column: draftColumn.nullable(), // add_column
  step: draftStep.nullable(), // add_step
  after: name.nullable(), // add_step: the step it comes after
  // rename: what is renamed (the capability, a sheet, a column or a step), from and to. instead_of_removal:
  // the admin asked to remove a step that holds rows, so it is renamed to what they said should replace it.
  rename: z.object({ what: z.enum(["capability", "sheet", "column", "step"]), from: name, to: name, instead_of_removal: z.boolean() }).nullable(),
  movers: z.object({ step: name, move_out: z.enum(MOVERS), move_in: z.enum(MOVERS) }).nullable(), // set_step_movers
  role: name.nullable(), // add_person_to_role, set_role_view
  person: z.string().nullable(), // add_person_to_role: a work email
  // rule: one plain sentence for the logic writer; replaces: the sentence of the rule it replaces, as it reads now.
  rule: z.object({ sentence: z.string().min(1), replaces: z.string().nullable() }).nullable(),
  view: z.object({ line: z.string().min(1).max(120), columns: z.array(name), form: z.array(name).nullable() }).nullable(), // set_role_view
  labels: z.object({ row_one: name.nullable(), row_many: name.nullable(), add_action: name.nullable(), buttons: z.array(z.object({ step: name, button: name })) }).nullable(),
  hint: z.object({ column: name, beside: name.nullable() }).nullable(), // set_hint_column: show column as a hint beside another, or on its own (null)
  sort: z.object({ column: name, dir: z.enum(["asc", "desc"]) }).nullable(), // set_default_sort
  check: z.object({ name, condition: z.string().min(1) }).nullable(), // add_sheet_check: an expression a new row must meet
  // set_form (0.3): the sheet's form as a whole: its tabs, each with sections (a name, or null for none) of questions, and
  // the questions asked when a row is added on top of the ones always asked (null: as it is; empty: none extra).
  form: z
    .object({
      tabs: z.array(z.object({ name, sections: z.array(z.object({ name: name.nullable(), columns: z.array(name) })) })),
      quick: z.array(name).nullable(),
    })
    .nullable(),
  // set_show_when (0.3): a question asked and shown only when the condition holds; condition null: always shown again.
  show_when: z.object({ column: name, condition: z.string().min(1).nullable() }).nullable(),
  // set_sheet_access (C1): how a role (role) sees a sheet's rows (sheet): all of them, by a person column on the
  // sheet (column), through a link column on the sheet (via) to a person column on the row it points to (column),
  // or not at all.
  access: z.object({ sees: z.enum(["all", "by_column", "through_link", "none"]), column: name.nullable(), via: name.nullable() }).nullable(),
  // link_column (M27): a typed text column (column) on the sheet becomes a link to rows of another sheet, matched by
  // their names; to_capability null: a sheet of this capability.
  link: z.object({ column: name, to_capability: name.nullable(), to_sheet: name }).nullable(),
  // set_formula (M29): a computed question's formula, written again (Left counting the leave entries). It moves no
  // data: the kernel works it out again for every row on Apply.
  formula: z.object({ column: name, formula: z.string().min(1) }).nullable().optional(),
  explain: z.string().min(1), // the Change column: "A Legal review step between Signed and Active, for contracts over $50,000"
  part: z.string().min(1).max(80), // its line in Apply's Part / Status list: "Steps: Legal review between Signed and Active"
});
export type CustomizeChange = z.infer<typeof customizeChange>;


// A change as a model wrote it, with what it left out that has one meaning filled in: a field it didn't write is null,
// and a missing Part / Status line is the first words of its explanation. Used by the prompts' fill (gateway), so the
// schema the model reads stays as it is.
export function fillChange(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const key of Object.keys(customizeChange.shape)) if (!(key in out)) out[key] = null;
  if ((out.part === null || out.part === "") && typeof out.explain === "string" && out.explain) out.part = out.explain.slice(0, 80);
  return out;
}
