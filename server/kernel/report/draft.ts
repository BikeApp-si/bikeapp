import { z } from "zod";
import { exprSchema, type Expr } from "../expr/ast";
import { querySchema, type ReportQuery } from "./schema";

// The query as prompt 7 writes it: flat, with every expression as a JSON string (as the logic writer writes
// rules), so its answer schema stays simple. The kernel parses each string and checks the whole query.

const ref = z.string(); // "Purchases.Amount"
const json = z.string().nullable(); // an expression, as JSON

export const draftQuery = z.object({
  from: z.array(z.object({ capability: z.string(), sheet: z.string() })),
  join: z.array(
    z.object({
      source: z.string(), // the joined sheet
      kind: z.enum(["equal", "link", "names"]), // the same value; a link column; the first's text names the second's value
      left: ref, // equal and names: a column of the joined sheet; link: the link column
      right: ref.nullable(), // equal and names: the column it matches in a sheet before it
    }),
  ),
  where: json,
  group_by: z.array(z.object({ column: ref, by: z.enum(["value", "month"]) })),
  measures: z.array(z.object({ fn: z.enum(["count", "sum", "avg", "min", "max", "first"]), source: z.string(), column: ref.nullable(), where: json, as: z.string(), hidden: z.boolean() })),
  computed: z.array(z.object({ as: z.string(), expr: json, template: z.string().nullable(), empty: z.string().nullable(), format: z.enum(["money", "number", "percent", "text"]) })),
  order_by: z.array(z.object({ column: z.string(), dir: z.enum(["asc", "desc"]) })),
  limit: z.number().int().nullable(),
});
export type DraftQuery = z.infer<typeof draftQuery>;

function parseExpr(s: string | null, where: string, problems: string[]): Expr | null {
  if (s === null || !s.trim()) return null;
  try {
    const out = exprSchema.safeParse(JSON.parse(s));
    if (out.success) return out.data;
    problems.push(`${where}: that isn't an expression Bike reads.`);
  } catch {
    problems.push(`${where}: that isn't JSON.`);
  }
  return null;
}

export function toQuery(d: DraftQuery): { query: ReportQuery | null; problems: string[] } {
  const problems: string[] = [];
  const candidate = {
    from: d.from.map((f) => ({ capability: f.capability, sheet: f.sheet, as: null })),
    join: d.join.map((j) => ({
      source: j.source,
      on: j.kind === "link" ? { link: j.left } : j.kind === "equal" ? { equal: [j.left, j.right ?? ""] as [string, string] } : { names: [j.left, j.right ?? ""] as [string, string] },
    })),
    where: parseExpr(d.where, "where", problems),
    groupBy: d.group_by.map((g) => (g.by === "month" ? { month: g.column } : { column: g.column })),
    measures: d.measures.map((m) => ({ ...m, where: parseExpr(m.where, `The measure ${m.as}`, problems) })),
    computed: d.computed.map((c) => ({ ...c, expr: parseExpr(c.expr, c.as, problems) })),
    orderBy: d.order_by,
    limit: d.limit,
  };
  const parsed = querySchema.safeParse(candidate);
  if (!parsed.success) problems.push(...parsed.error.issues.map((i) => `${i.path.join(" › ")}: ${i.message}`));
  return { query: problems.length ? null : parsed.data!, problems };
}

// The other way, for a report the admin asks to change (11e): the query as the prompt writes it.
export function toDraft(q: ReportQuery): DraftQuery {
  return {
    from: q.from.map((f) => ({ capability: f.capability, sheet: f.sheet })),
    join: q.join.map((j) => ("link" in j.on ? { source: j.source, kind: "link" as const, left: j.on.link, right: null } : "equal" in j.on ? { source: j.source, kind: "equal" as const, left: j.on.equal[0], right: j.on.equal[1] } : { source: j.source, kind: "names" as const, left: j.on.names[0], right: j.on.names[1] })),
    where: q.where === null ? null : JSON.stringify(q.where),
    group_by: q.groupBy.map((g) => ("month" in g ? { column: g.month, by: "month" as const } : { column: g.column, by: "value" as const })),
    measures: q.measures.map((m) => ({ ...m, column: m.column ?? null, where: m.where === null ? null : JSON.stringify(m.where) })),
    computed: q.computed.map((c) => ({ ...c, expr: c.expr === null ? null : JSON.stringify(c.expr) })),
    order_by: q.orderBy,
    limit: q.limit,
  };
}
