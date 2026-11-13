import { and, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { rows } from "@/db/schema";
import { accessTo } from "./access";
import { startWork, type KernelCtx } from "./context";
import type { Tx } from "./tx";

// Counts about a capability's data, for the Customize advisor (C3): per sheet, how many rows, how many are empty in
// each question, and how often each choice or step is used. Counts only, never a value someone typed (no text, money,
// people or dates), and only over the rows the asking person may see. Read-only.

export type SheetProfile = {
  sheet: string;
  rows: number;
  empty: Record<string, number>; // question → rows where it's empty (only questions with any)
  used: Record<string, { name: string; rows: number }[]>; // choice or step question → its most used, at most 8
};

const r = alias(rows, "r");
const TOP = 8;

export async function capabilityProfile(tx: Tx, ctx: KernelCtx, capId: string): Promise<SheetProfile[]> {
  const w = await startWork(tx, ctx);
  const access = await accessTo(tx, w.loaded, capId, ctx.actor.id);
  if (!access) return [];
  const out: SheetProfile[] = [];
  for (const sheet of access.cap.file.sheets) {
    if (sheet.kind === "lines") continue;
    const visible = access.visible(sheet.id, "r");
    if (!visible) continue;
    const where = and(eq(r.capabilityId, capId), eq(r.sheetId, sheet.id), isNull(r.deletedAt), visible);
    const fillable = sheet.columns.filter((c) => c.type !== "computed");
    const counts = sql.join(
      [sql`count(*)::int as "rows"`, ...fillable.map((c) => sql`count(*) filter (where coalesce(${r.data}->>${c.id}, '') in ('', '[]'))::int as ${sql.identifier(`e_${c.id}`)}`)],
      sql`, `,
    );
    const [row] = (await tx.execute(sql`select ${counts} from rows r where ${where}`)) as unknown as Record<string, number>[];
    const empty: Record<string, number> = {};
    for (const c of fillable) if (row?.[`e_${c.id}`]) empty[c.name] = row[`e_${c.id}`]!;

    const used: Record<string, { name: string; rows: number }[]> = {};
    for (const c of sheet.columns.filter((x) => x.type === "choice" || x.type === "step")) {
      const names = new Map((c.type === "step" ? (sheet.steps ?? []) : (c.options ?? [])).map((o) => [o.id, o.name]));
      const got = await tx
        .select({ v: sql<string>`${r.data}->>${c.id}`, n: sql<number>`count(*)::int` })
        .from(r)
        .where(and(where, sql`coalesce(${r.data}->>${c.id}, '') <> ''`))
        .groupBy(sql`1`)
        .orderBy(sql`2 desc, 1`)
        .limit(TOP);
      // Only names the capability defines: a value that isn't one of its choices is never sent.
      const list = got.flatMap((g) => (names.has(g.v) ? [{ name: names.get(g.v)!, rows: g.n }] : []));
      if (list.length) used[c.name] = list;
    }
    out.push({ sheet: sheet.name, rows: row?.rows ?? 0, empty, used });
  }
  return out;
}
