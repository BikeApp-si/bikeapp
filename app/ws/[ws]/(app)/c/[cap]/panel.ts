import { load, todayIn, type KernelCtx } from "@/server/kernel/context";
import { getRow, movesFor } from "@/server/kernel/rows";
import type { Tx } from "@/server/kernel/tx";
import { dateLine, namesFor } from "@/server/kernel/views";
import { rowWait } from "@/server/kernel/waiting";
import { currentTime } from "@/server/kernel/clock";

// One row as the record panel shows it: its values, the steps the person can move it to, the names it points
// at, what waits on them in it (X1), and the line under its title (7a). Used by the page and its actions.
export async function panelRow(tx: Tx, ctx: KernelCtx, rowId: string) {
  const row = await getRow(tx, ctx, rowId);
  const loaded = await load(tx);
  const cap = loaded.files.get(row.capabilityId)!;
  const sheet = cap.file.sheets.find((s) => s.id === row.sheetId)!;
  return {
    row,
    moves: await movesFor(tx, ctx, rowId),
    names: await namesFor(tx, ctx, sheet, [row]),
    wait: await rowWait(tx, ctx, rowId),
    line: dateLine(loaded.rules, cap, sheet, row.data, todayIn(loaded.timeZone, ctx.now ?? currentTime()), loaded.formats),
  };
}
