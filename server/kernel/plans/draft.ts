import { z } from "zod";
import { COLUMN_TYPES, MOVERS, PERMISSIONS, RESULT_TYPES, SHEET_KINDS } from "../schema/file";

// A plan as the AI writes it: everything by name, never by id. The kernel compiles it into capability files
// (compile.ts), checking every name, type and person, before anything is shown.
//
// Expressions (defaults, formulas, conditions, field maps) are the kernel's expression JSON written with
// names: {"col":"Start"}, {"col":"Total","via":"Purchase"}, {"op":"gt","args":[{"col":"Value a year"},50000]},
// {"sumOf":{"capability":"Supplier bills","sheet":"Bills","column":"Amount","by":"Budget","steps":["Paid"]}}.
// Money is in dollars, choices and steps by their names, people by their work email.
//
// Every field is present (null or empty when unused), so the shape works with structured outputs.

const name = z.string().min(1).max(80);
const expr = z.string().min(1); // expression JSON, by name

export const draftColumn = z.object({
  name,
  type: z.enum(COLUMN_TYPES),
  required: z.boolean(),
  // value: a fixed value as JSON (30, "Standard"); creator: whoever adds the row; today; formula: an
  // expression used when the field is left empty (Start + 1 year).
  default: z.object({ kind: z.enum(["value", "creator", "today", "formula"]), value: z.string().nullable() }).nullable(),
  options: z.array(name), // choice
  // link; capability null = this one. pick (G1): a pick from a list (a cost centre, a category, a customer): deleting
  // the row it points to empties it and the row stays; false or left out: the row belongs to it and goes with it.
  link: z.object({ capability: name.nullable(), sheet: name, pick: z.boolean().nullable().optional() }).nullable(),
  formula: expr.nullable(), // computed
  result: z.enum(RESULT_TYPES).nullable(), // computed
});

export const draftStep = z.object({
  name,
  start: z.boolean(),
  end: z.enum(["final", "exit"]).nullable(),
  button: name.nullable(),
  only_when: expr.nullable(), // the step can't be skipped while this holds
  move_out: z.enum(MOVERS),
  move_in: z.enum(MOVERS),
});

export const draftSheet = z.object({
  name,
  kind: z.enum(SHEET_KINDS),
  parent_sheet: name.nullable(), // lines
  // tree (M28): the link column to this same sheet that names the row each row sits under. Left out or null otherwise.
  tree_parent: name.nullable().optional(),
  // ledger (M29): whose balance each entry counts toward (a person column, or a link to a row of another sheet: the
  // item), the signed amount, and the lowest the balance may go (0 for stock), or null for none. Bike adds the
  // balance after each entry and the link to the entry a reversal reverses itself. Left out or null otherwise.
  ledger_account: name.nullable().optional(),
  ledger_amount: name.nullable().optional(),
  ledger_min: z.number().nullable().optional(),
  // dated (M30): what each row's value is for (a choice, a link to the item, a person; null for one series, the
  // mileage rate) and the date column each row starts on. Bike adds Until itself. Left out or null otherwise.
  dated_key: name.nullable().optional(),
  dated_from: name.nullable().optional(),
  title_column: name,
  row_one: name, // "contract"
  row_many: name, // "contracts"
  add_action: name.nullable(), // "New contract"
  columns: z.array(draftColumn),
  steps: z.array(draftStep), // empty for a plain list
});

export const draftRole = z.object({
  name,
  people: z.array(z.string()), // work emails
  person_column: z.object({ sheet: name, column: name }).nullable(), // whoever this column names ("Contract owners")
  everyone: z.boolean(),
  can: z.array(z.enum(PERMISSIONS)),
  scope: z.enum(["all", "own", "team"]),
  // own / team: per sheet, the person column that decides, on the row or one link away.
  scope_columns: z.array(z.object({ sheet: name, column: name, via: name.nullable() })),
  sheets: z.array(name).nullable(), // all sheets when null
});

export const draftCapability = z.object({
  name,
  icon: z.string().regex(/^[a-z0-9-]+$/),
  sheets: z.array(draftSheet),
  roles: z.array(draftRole),
  later: z.array(z.string()),
});

export const draftAction = z.object({
  kind: z.enum(["create_row_in", "update_row_in", "move_to_step", "notify", "ask_person", "ai_step"]),
  step: name.nullable(), // move_to_step, ask_person: wait at this step
  target: z.object({ capability: name.nullable(), sheet: name }).nullable(), // create_row_in, update_row_in
  via: name.nullable(), // update_row_in: the link column to the row it updates; ask_person: the link to the row whose person column names them
  map: z.array(z.object({ column: name, value: expr })), // target column ← value from the row that ran the rule
  people: z.array(z.string()), // notify: work emails
  columns: z.array(name), // notify: person columns
  message: z.string().nullable(), // notify
  person: z.string().nullable(), // ask_person: a work email
  column: name.nullable(), // ask_person: a person column
  manager_of: name.nullable(), // ask_person: the manager of the person in this column
  until: name.nullable(), // ask_person: waits until this column is filled
  label: z.string().max(60).nullable(), // ask_person: what they are asked to do
  decision: z.object({ column: name, approve: name, decline: name }).nullable(), // ask_person: Approve / Decline into a choice column
  question: z.string().nullable(), // ai_step
  answer_column: name.nullable(), // ai_step: the column it proposes a value for
});

export const draftRule = z.object({
  capability: name, // where its trigger sheet is: the new capability or one that exists
  text: z.string().min(1), // the admin's sentence
  when: z.string().min(1), // plain reading
  then: z.string().min(1),
  sheet: name,
  trigger: z.object({
    kind: z.enum(["row_created", "enters_step", "field_changed", "date_reached", "repeats"]),
    step: name.nullable(),
    field: name.nullable(),
    date: name.nullable(),
    // date_reached that counts from the day the row was added, not a column (logic-writer@3).
    from_added: z.boolean().optional(),
    offset_days: z.number().int().nullable(),
    // repeats (M32, logic-writer@7): its schedule, and the dates it starts and ends on.
    every: z
      .object({
        unit: z.enum(["week", "month", "year"]),
        weekday: z.enum(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]).nullable(),
        day: z.number().int().nullable(),
        month: z.number().int().nullable(),
      })
      .nullable()
      .optional(),
    starts: z.string().nullable().optional(),
    ends: z.string().nullable().optional(),
  }),
  condition: expr.nullable(),
  actions: z.array(draftAction),
});

// A change in a capability that already exists. Additions, and (M27) one data move: a typed column turned into a
// link, whose rows the kernel moves on Create.
export const draftEdit = z.object({
  kind: z.enum(["add_column", "add_step", "add_role_member", "link_column"]),
  sheet: name.nullable(),
  column: draftColumn.nullable(),
  step: draftStep.nullable(),
  after: name.nullable(), // add_step: the step it comes after
  role: name.nullable(), // add_role_member
  person: z.string().nullable(), // add_role_member: a work email
  // link_column: a typed text column on the sheet becomes a link to rows of another sheet (the new capability's,
  // or one already there), matched by their names; to_capability null: this capability.
  link: z.object({ column: name, to_capability: name.nullable(), to_sheet: name }).nullable(),
});

export const draftAlsoChange = z.object({
  capability: name,
  sheet: name.nullable(),
  change: z.string().min(1), // "Add a Received quantity column"
  reason: z.string().min(1), // "So each bill can be matched to what arrived"
  kind: z.enum(["add", "restructure"]),
  // What the kernel applies. A restructure's is its link_column edit; a restructure with no edits is a data move
  // Bike can't do yet, named only.
  edits: z.array(draftEdit),
});

export type DraftColumn = z.infer<typeof draftColumn>;
export type DraftStep = z.infer<typeof draftStep>;
export type DraftSheet = z.infer<typeof draftSheet>;
export type DraftRole = z.infer<typeof draftRole>;
export type DraftCapability = z.infer<typeof draftCapability>;
export type DraftAction = z.infer<typeof draftAction>;
export type DraftRule = z.infer<typeof draftRule>;
export type DraftEdit = z.infer<typeof draftEdit>;
export type DraftAlsoChange = z.infer<typeof draftAlsoChange>;
