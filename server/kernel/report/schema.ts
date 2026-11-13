import { z } from "zod";
import { exprSchema } from "../expr/ast";

// A report's query (11a–11g), in the kernel's own read-only schema: never SQL. Prompt 7 writes it with
// names ("Purchases.Status"); the kernel checks every name against the files the asking admin can see and
// runs it with their access. Values in conditions are as the expressions write them: money in dollars,
// dates as "2026-10-01", choices and steps by name, people by full name, and { "ref": "today" }.

const ref = z.string().regex(/^[^.]+\.[^.]+$/, "Name a column as Sheet.Column."); // "Purchases.Amount"

export const sourceSchema = z.object({
  capability: z.string().min(1),
  sheet: z.string().min(1),
  as: z.string().min(1).nullable(), // what conditions call it; the sheet's name when null
});

// How a source after the first relates to one before it.
export const joinSchema = z.object({
  source: z.string().min(1), // the joined source, by its name
  on: z.union([
    z.object({ equal: z.tuple([ref, ref]) }), // the same value: a team, a person, a date
    z.object({ link: ref }), // a link column on one side that points at the other's rows
    z.object({ names: z.tuple([ref, ref]) }), // the first's text names the second's value ("Laptop for Mei Chen")
  ]),
});

export const groupSchema = z.union([z.object({ column: ref }), z.object({ month: ref })]);

export const measureSchema = z.object({
  fn: z.enum(["count", "sum", "avg", "min", "max", "first"]),
  source: z.string().min(1), // whose rows it adds up
  column: ref.nullable(), // count with none counts rows
  where: exprSchema.nullable(), // only some of those rows ("tasks that are Done")
  as: z.string().min(1),
  hidden: z.boolean(), // used by a computed column only
});

export const computedSchema = z.object({
  as: z.string().min(1),
  // A value from the measures (and group columns) by name: { "op": "sub", "args": [{ "col": "Budget" }, { "col": "Spent" }] }.
  expr: exprSchema.nullable(),
  // Or words with the measures in them: "{Done} of {Tasks} tasks done", and what to say when they're all empty.
  template: z.string().nullable(),
  empty: z.string().nullable(),
  format: z.enum(["money", "number", "percent", "text"]),
});

export const querySchema = z.object({
  from: z.array(sourceSchema).min(1).max(4),
  join: z.array(joinSchema).max(3),
  where: exprSchema.nullable(), // an "and" of conditions, each about one source
  groupBy: z.array(groupSchema).max(3),
  measures: z.array(measureSchema).max(8),
  computed: z.array(computedSchema).max(4),
  orderBy: z.array(z.object({ column: z.string().min(1), dir: z.enum(["asc", "desc"]) })).max(2),
  limit: z.number().int().positive().max(500).nullable(),
});

export type ReportQuery = z.infer<typeof querySchema>;
export type ReportSource = z.infer<typeof sourceSchema>;

export type ColumnFormat = "money" | "number" | "percent" | "text" | "month" | "date";
export type ReportResult = {
  columns: { name: string; format: ColumnFormat }[];
  rows: (string | number | null)[][];
  total?: (string | number | null)[] | null; // "Total", then each column's total; none for one group
  // Per source: rows read (after its conditions) and rows its conditions left out.
  sources: { capability: string; sheet: string; name: string; read: number; leftOut: number }[];
};
