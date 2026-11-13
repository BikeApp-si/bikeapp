import { columnsUsed } from "@/server/kernel/expr/ast";
import type { SheetView } from "./types";

// How a record's questions are laid out. A form this short reads better as one list of sections; a longer one keeps
// the tabs it was given.
export const SECTIONS_UP_TO = 12;

type Section = { name: string | null; columns: string[] };
type Tab = { name: string; sections: Section[] };

export const questionCount = (sheet: Pick<SheetView, "tabs">) => sheet.tabs.flatMap((t) => t.sections.flatMap((s) => s.columns)).length;

// The record's tabs. Several tabs on a short form become one, with a section for each, named as the new form names them.
export function recordLayout(sheet: Pick<SheetView, "tabs" | "columns">): Tab[] {
  const tabs = withWorkedOut(sheet);
  if (tabs.length === 1 || questionCount(sheet) > SECTIONS_UP_TO) return tabs;
  return [{ name: "Details", sections: tabs.map((t) => ({ name: t.name, columns: t.sections.flatMap((s) => s.columns) })) }];
}

// The sheet's tabs with what it works out placed after the last question each one reads (else at the end of the
// first tab), since tabs hold only questions people answer.
export function withWorkedOut(sheet: Pick<SheetView, "tabs" | "columns">): Tab[] {
  // One tab: every column in sheet order, as 7a and X1 show it.
  if (sheet.tabs.length === 1) return [{ ...sheet.tabs[0]!, sections: [{ name: null, columns: sheet.columns.filter((c) => c.type !== "step").map((c) => c.id) }] }];
  const tabs = sheet.tabs.map((t) => ({ ...t, sections: t.sections.map((s) => ({ ...s, columns: [...s.columns] })) }));
  for (const c of sheet.columns) {
    if (c.type !== "computed" || !c.expr) continue;
    const reads = columnsUsed(c.expr);
    let placed = false;
    for (const t of [...tabs].reverse()) {
      for (const s of [...t.sections].reverse()) {
        const i = s.columns.findLastIndex((id) => reads.includes(id));
        if (i < 0) continue;
        s.columns.splice(i + 1, 0, c.id);
        placed = true;
        break;
      }
      if (placed) break;
    }
    if (!placed) tabs[0]?.sections[0]?.columns.push(c.id);
  }
  return tabs;
}
