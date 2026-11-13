import type { CurrentFile, Work } from "./context";
import { envFor, withOtherRows } from "./env";
import { evaluate } from "./expr/evaluate";
import { renderExpr } from "./expr/render";
import type { Sheet } from "./schema/file";

// A sheet's checks on a new row (8f: "Within your balance"). A check that isn't met refuses the add, with its
// name and the condition in plain words.

export type CheckResult = { name: string; ok: boolean; reason: string | null };

export async function runChecks(w: Work, cap: CurrentFile, sheet: Sheet, rowId: string | null, data: Record<string, unknown>): Promise<CheckResult[]> {
  const full = await withOtherRows(w, cap, sheet, rowId, data);
  const words = {
    column: (id: string) => sheet.columns.find((c) => c.id === id),
    otherColumn: (sheetId: string, column: string) => {
      const other = cap.file.sheets.find((s) => s.id === sheetId);
      return { sheet: other?.name ?? sheetId, column: other?.columns.find((c) => c.id === column)?.name ?? column };
    },
    personName: (id: string) => w.loaded.people.get(id)?.name,
  };
  const out: CheckResult[] = [];
  for (const c of sheet.checks ?? []) {
    const ok = evaluate(c.condition, await envFor(w, cap, sheet, rowId, full, [c.condition])) === true;
    out.push({ name: c.name, ok, reason: ok ? null : `${c.name}: it needs ${renderExpr(c.condition, words)}.` });
  }
  return out;
}
