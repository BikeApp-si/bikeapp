import { z } from "zod";
import { exprSchema } from "../expr/ast";

// The capability file: one JSON document per version, validated here and cross-checked in validate.ts.
// Rows store values by these ids, never by names, so a rename only changes the name.

const id = z.string().regex(/^[a-z0-9_]{1,40}$/, "Ids are lowercase letters, digits and _");
const name = z.string().trim().min(1).max(80);

export const COLUMN_TYPES = [
  "text", "long_text", "number", "money", "money_range", "percent", "date", "datetime", "days",
  "person", "email", "phone", "url", "file", "choice", "link", "step", "computed",
] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

// What a computed column gives back, so it can be shown, compared and added up.
export const RESULT_TYPES = ["number", "money", "percent", "days", "date", "text"] as const;

export const defaultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("value"), value: z.unknown() }),
  z.strictObject({ kind: z.literal("creator") }), // "whoever adds it"
  z.strictObject({ kind: z.literal("today") }),
  z.strictObject({ kind: z.literal("expr"), expr: exprSchema }), // used when the field is left empty
]);

export const columnSchema = z.strictObject({
  id,
  name,
  type: z.enum(COLUMN_TYPES),
  required: z.boolean().optional(),
  default: defaultSchema.optional(),
  options: z.array(z.strictObject({ id, name })).optional(), // choice
  min: z.number().finite().optional(), // number
  max: z.number().finite().optional(),
  // link; capability left out = this one. pick (G1): a pick from a list (cost centre, category, customer): deleting the
  // row it points to empties it, and this row stays. Without it, a row that links to a deleted row of its own app goes
  // with it (a contract's renewals and contacts).
  link: z.strictObject({ capability: z.string().optional(), sheet: id, pick: z.literal(true).optional() }).optional(),
  expr: exprSchema.optional(), // computed
  result: z.enum(RESULT_TYPES).optional(), // computed
  // computed: shown as a hint beside this other column ("30 days · notice date Oct 15"), not as its own column.
  hintFor: id.optional(),
  // 0.3: the question is asked and shown only when this holds for the row ("Receipt, when Amount is over $75"); a
  // question that isn't shown is never required.
  showWhen: exprSchema.optional(),
  // 0.5 (M27): a typed column a link took the place of. It keeps its values, read only, so the move can be checked
  // and undone; the link column named here holds what it held, as links.
  replacedBy: id.optional(),
});

// anyone: whoever their role lets move the row. submitter: only the person the row is for (who asked).
// not_submitter: anyone but them, so nobody approves their own request.
export const MOVERS = ["anyone", "submitter", "not_submitter"] as const;
export type Mover = (typeof MOVERS)[number];

// A step's colour as a pill. Left out: grey for the start, "done" for an end, violet for the rest.
export const TONES = ["grey", "blue", "green", "orange", "yellow", "violet", "done"] as const;

export const stepSchema = z.strictObject({
  id,
  name,
  start: z.literal(true).optional(),
  // exit: a row can leave for it from any step (Declined, Rejected). final: reached only by moving forward (Taken, Paid).
  end: z.enum(["exit", "final"]).optional(),
  // Who may move a row out of this step, and into it, on top of their role. "anyone" when left out.
  moveOut: z.enum(MOVERS).optional(),
  moveIn: z.enum(MOVERS).optional(),
  onlyWhen: exprSchema.optional(), // "Legal review, for contracts over $50,000"
  tone: z.enum(TONES).optional(),
  button: name.optional(), // what the button that moves a row here says ("Mark renewed"); the step's name when left out
});

// 0.5 (M28): a tree is a list whose rows can sit under another row of the same sheet (cost centres, categories).
// 0.5 (M29): a ledger's entries are only added, never changed or deleted; a wrong one is reversed (leave, stock moves).
// 0.5 (M30): a dated sheet keeps values by the date each starts (price lists, salaries, limits); one in force is kept.
export const SHEET_KINDS = ["list", "document", "lines", "allocation", "tree", "ledger", "dated"] as const;

// A check a new row must pass before it is added ("Within your balance"), shown in the form as it is typed.
export const checkSchema = z.strictObject({ id, name, condition: exprSchema });

// 0.3: how a row's questions are laid out in its record: tabs ("Basics", "Dates"), each with sections (a name, or
// none), and the questions asked when a row is added on top of the ones the kernel always asks (formFor, form.ts).
export const formSchema = z.strictObject({
  tabs: z.array(z.strictObject({ name, sections: z.array(z.strictObject({ name: name.nullable(), columns: z.array(id) })).min(1) })).min(1),
  quick: z.array(id).optional(),
});

export const sheetSchema = z.strictObject({
  id,
  name,
  kind: z.enum(SHEET_KINDS),
  titleColumn: id,
  parentSheet: id.optional(), // lines: the document sheet they belong to
  // allocation: the two link columns, the amount, and the columns on each side it may not go above.
  allocation: z
    .strictObject({ from: id, to: id, amount: id, fromLimit: id, toLimit: id.optional() })
    .optional(),
  // tree: the link column that names the row each row sits under (empty for the ones at the top).
  tree: z.strictObject({ parent: id }).optional(),
  // ledger: whose balance each entry counts toward (a person, or a link to a row: the item), the signed amount, the
  // column the kernel keeps for the balance after each entry, the link to the entry a reversal reverses, and, when
  // set, the lowest the balance may go (stock: 0), checked on every write.
  ledger: z.strictObject({ account: id, amount: id, balance: id, reverses: id, min: z.number().finite().optional() }).optional(),
  // dated: what each row's value is for (a category, a product, a person; left out for one series, the mileage rate),
  // the date it starts, and the column the kernel keeps for the day before the next one for the same key starts.
  dated: z.strictObject({ key: id.optional(), from: id, until: id }).optional(),
  columns: z.array(columnSchema).min(1),
  steps: z.array(stepSchema).optional(), // the flow of the sheet's step column
  row: z.strictObject({ one: name, many: name }).optional(), // what a row is called: "contract" / "contracts"
  addAction: name.optional(), // the form's name in Do it yourself ("Request time off"); "New {row}" when left out
  // The table's order (oldest first when left out), and an order within it: 8b by Status, then newest first.
  sort: z.strictObject({ column: id, dir: z.enum(["asc", "desc"]), then: z.strictObject({ column: id, dir: z.enum(["asc", "desc"]) }).optional() }).optional(),
  checks: z.array(checkSchema).optional(),
  form: formSchema.optional(),
});

export const PERMISSIONS = ["see", "add", "edit", "delete", "move_steps", "customize"] as const;

// What a role's people see in place of the Data tab (8a–8d): one sheet, a line under the header, some columns
// and the fields of its form. It only chooses what is shown; access stays the role's.
export const viewSchema = z.strictObject({
  sheet: id,
  line: z.string().trim().min(1).max(120), // "Your own expenses"
  columns: z
    .array(
      z.strictObject({
        column: id,
        name: name.optional(), // the header, when not the column's own name ("Dates")
        hint: id.optional(), // a column shown after it ("Oct 9 · no receipt yet")
        to: id.optional(), // a date column that ends the range starting at column ("Dec 28–31")
      }),
    )
    .min(1),
  next: id.optional(), // shown under Next when nothing waits on the row ("Referred by Maya Chen")
  // The add form's rows, in order: a field, or two side by side (8f: From | To). The sheet's columns when left out.
  form: z.array(z.union([id, z.tuple([id, id])])).optional(),
});
export type Permission = (typeof PERMISSIONS)[number];

export const roleSchema = z.strictObject({
  id,
  name,
  members: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("people"), people: z.array(z.uuid()) }),
    // Whoever a person column names on some row ("Contract owners").
    z.strictObject({ kind: z.literal("column"), sheet: id, column: id }),
    z.strictObject({ kind: z.literal("everyone") }),
  ]),
  can: z.array(z.enum(PERMISSIONS)).min(1),
  moveFrom: z.array(id).optional(), // move_steps listed: the steps this role may move rows out of; all when left out
  sheets: z.array(id).optional(), // all sheets when left out
  scope: z.enum(["all", "own", "team"]),
  // own / team: per sheet, the person column that decides, on the row or one hop through a link column.
  scopeColumns: z.record(z.string(), z.strictObject({ column: id, via: id.optional() })).optional(),
  view: viewSchema.optional(),
  // C1: added by Customize beside a role, for one sheet, so the same people see it another way. The plain text
  // reads it inside that role's sentence. With no sheets left it's switched off: the role itself sees the sheet again.
  beside: z.strictObject({ role: id, sheet: id }).optional(),
});

const ref = z.strictObject({ capability: z.string().optional(), sheet: id });
const fieldMap = z.record(z.string(), exprSchema); // target column id → value from the row that ran the rule

export const actionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("create_row_in"), target: ref, map: fieldMap }),
  z.strictObject({ kind: z.literal("update_row_in"), target: ref, via: id, map: fieldMap }),
  z.strictObject({ kind: z.literal("move_to_step"), step: id }),
  z.strictObject({
    kind: z.literal("notify"),
    people: z.array(z.uuid()).optional(),
    columns: z.array(id).optional(),
    message: z.string().min(1),
  }),
  // The row waits on one person: named, in a person column (on this row or one link away), or the manager of
  // the person in a column. It waits at a step (moved there first), or until a column is filled. With a
  // decision, the person approves or declines; that is written to a choice column and ends the wait.
  z.strictObject({
    kind: z.literal("ask_person"),
    step: id.optional(),
    until: id.optional(),
    person: z.uuid().optional(),
    column: id.optional(),
    via: id.optional(), // column is on the row this link column points at
    managerOf: id.optional(), // the manager of the person in this column
    label: z.string().trim().min(1).max(60).optional(), // what they are asked to do ("Your scorecard")
    decision: z.strictObject({ column: id, approve: id, decline: id }).optional(),
  }),
  // person: who confirms its proposals (Waiting on me); none, and whoever can edit the row may (Oct 29).
  z.strictObject({ kind: z.literal("ai_step"), question: z.string().min(1), column: id.optional(), person: z.uuid().optional() }),
]);

// A repeating rule's schedule (M32): every week on a weekday (1 Monday … 7 Sunday), every month on a day (the 29th–31st
// fall on a shorter month's last day), every year on a month and day (Feb 29 on Feb 28 in other years).
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const everySchema = z.strictObject({
  unit: z.enum(["week", "month", "year"]),
  weekday: z.number().int().min(1).max(7).optional(),
  day: z.number().int().min(1).max(31).optional(),
  month: z.number().int().min(1).max(12).optional(),
});
export type Every = z.infer<typeof everySchema>;

export const ruleSchema = z.strictObject({
  id,
  text: z.string().min(1),
  reading: z.strictObject({ when: z.string().min(1), then: z.string().min(1) }),
  trigger: z.strictObject({
    kind: z.enum(["row_created", "enters_step", "field_changed", "date_reached", "repeats"]),
    sheet: id, // for repeats: the sheet it adds rows to
    step: id.optional(),
    field: id.optional(),
    date: id.optional(),
    from: z.literal("added").optional(), // a date rule that counts from the day the row was added, not a column
    offsetDays: z.number().int().optional(),
    // M32, rows that repeat: a rule with no row, run by the daily job on each date of its schedule.
    every: everySchema.optional(),
    starts: isoDate.optional(), // the first date it may add on (left out: the day it was saved)
    ends: isoDate.optional(), // the last date it may add on
  }),
  condition: exprSchema.optional(),
  actions: z.array(actionSchema).min(1),
  enabled: z.boolean(),
});

export const capabilityFileSchema = z.strictObject({
  name,
  icon: z.string().regex(/^[a-z0-9-]+$/).default("layout-grid"),
  description: z.string().max(200).optional(), // the line under the header ("Openings, candidates and interviews")
  sheets: z.array(sheetSchema).min(1),
  roles: z.array(roleSchema),
  rules: z.array(ruleSchema),
  later: z.array(z.string()),
});

export type CapabilityFile = z.infer<typeof capabilityFileSchema>;
export type Sheet = z.infer<typeof sheetSchema>;
export type Column = z.infer<typeof columnSchema>;
export type Step = z.infer<typeof stepSchema>;
export type Role = z.infer<typeof roleSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type Action = z.infer<typeof actionSchema>;
export type Default = z.infer<typeof defaultSchema>;

// A ledger's own columns (M29), or null for any other sheet.
type LedgerLike = { kind: Sheet["kind"]; ledger?: Sheet["ledger"] | null; dated?: Sheet["dated"] | null };
export const ledgerOf = (sheet: LedgerLike) => (sheet.kind === "ledger" && sheet.ledger ? sheet.ledger : null);

// A dated sheet's own columns (M30), or null for any other sheet.
export const datedOf = (sheet: LedgerLike) => (sheet.kind === "dated" && sheet.dated ? sheet.dated : null);

// Columns the kernel fills, never a person: a ledger's balance after each entry, and the entry a reversal reverses; a
// dated sheet's Until.
export const keptByKernel = (sheet: LedgerLike, columnId: string) => {
  const l = ledgerOf(sheet);
  if (l) return columnId === l.balance || columnId === l.reverses;
  return datedOf(sheet)?.until === columnId;
};
