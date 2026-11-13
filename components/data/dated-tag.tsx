"use client";

import { Pill } from "@/components/chips";
import { formatDay, type Formats } from "@/lib/format";
import type { Row, SheetView } from "./types";

// A dated sheet's row (M30): "In force" today, or "From Nov 1" while still to come. Nothing once it's over.
export function DatedTag({ sheet, row, fmt, large }: { sheet: SheetView; row: Row; fmt: Formats; large?: boolean }) {
  if (!sheet.dated || !row.dated || row.dated === "past") return null;
  const from = row.data[sheet.dated.from];
  const size = large ? "h-[22px] text-[13.5px]" : "h-[18px] text-[12px]";
  if (row.dated === "now") return <Pill tone="green" className={`${size} shrink-0 font-medium`}>In force</Pill>;
  return typeof from === "string" ? <Pill tone="blue" className={`${size} shrink-0 font-medium`}>From {formatDay(from, fmt)}</Pill> : null;
}

// A row of a dated sheet that has started is kept as it is: only one still to come may be changed or deleted.
export const keptAsItIs = (sheet: SheetView, row: Row) => !!sheet.dated && row.dated !== "later";
