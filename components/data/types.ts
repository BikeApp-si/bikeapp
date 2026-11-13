import type { Column, Step } from "@/server/kernel/schema/file";
import type { SheetView } from "@/server/kernel/views";

// What the Data tab's client parts are given by the page and the server actions.
export type { Column, Step, SheetView };
export type Person = { id: string; name: string; tint: string; title?: string | null; team?: string | null };
export type Names = { people: Record<string, string>; rows: Record<string, string>; files: Record<string, string> };
// level and branch: a tree read in its own order (M28).
// reversed: a ledger's entry another entry reverses (M29). dated: a dated sheet's row in force, still to come or over (M30).
export type Row = {
  id: string;
  sheetId: string;
  data: Record<string, unknown>;
  stepId: string | null;
  level?: number;
  branch?: boolean;
  reversed?: boolean;
  dated?: "now" | "later" | "past";
};
export type Totals = { count: number; sums: Record<string, number> };
