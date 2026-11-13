import { capabilitiesFor } from "../capabilities";
import { currentTime } from "../clock";
import { load, type KernelCtx } from "../context";
import { listRows } from "../rows";
import type { Tx } from "../tx";

// What prompt 7 may know about the data besides its structure: how many rows each sheet has and the range of
// each date column, as the admin sees them. Counts, never rows (so 11g can say "Spend only has expenses from
// Jul 1, 2026").
export async function reportFacts(tx: Tx, ctx: KernelCtx, asOf = ctx.now ?? currentTime()) {
  const loaded = await load(tx);
  const out: { capability: string; sheet: string; rows: number; dates: Record<string, [string, string]> }[] = [];
  for (const c of await capabilitiesFor(tx, ctx)) {
    const file = loaded.files.get(c.id)!.file;
    for (const sheet of file.sheets) {
      const list = (await listRows(tx, ctx, c.id, sheet.id)).filter((r) => r.createdAt.getTime() <= asOf.getTime());
      const dates: Record<string, [string, string]> = {};
      for (const col of sheet.columns.filter((x) => x.type === "date")) {
        const vs = list.map((r) => r.data[col.id]).filter((v): v is string => typeof v === "string").sort();
        if (vs.length) dates[col.name] = [vs[0]!, vs.at(-1)!];
      }
      out.push({ capability: file.name, sheet: sheet.name, rows: list.length, dates });
    }
  }
  return out;
}
