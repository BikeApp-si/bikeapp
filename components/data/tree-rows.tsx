import { ChevronDown, ChevronRight } from "lucide-react";
import type { Row } from "./types";

// A tree in the table (M28, m28-a): each row indented under the row it sits under, with a fold on each row that has
// rows under it. The kernel sends the rows in order with their level; folding is the person's, on this page only.

const INDENT = 22;

// The rows a fold hides: everything under a folded row, until the next row at its level or above.
export function hiddenByFolds(rows: Row[], folded: readonly string[]): Set<string> {
  const hidden = new Set<string>();
  let below: number | null = null;
  for (const r of rows) {
    const level = r.level ?? 0;
    if (below !== null && level > below) {
      hidden.add(r.id);
      continue;
    }
    below = r.branch && folded.includes(r.id) ? level : null;
  }
  return hidden;
}

export function TreeIndent({ row, folded, onToggle, children }: { row: Row; folded: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: (row.level ?? 0) * INDENT }}>
      {row.branch ? (
        <button
          type="button"
          aria-label={folded ? "Show the rows under it" : "Hide the rows under it"}
          aria-expanded={!folded}
          onClick={(e) => (e.stopPropagation(), onToggle())}
          className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-[4px] text-muted outline-none hover:bg-fill hover:text-ink focus-visible:ring-2 focus-visible:ring-focus"
        >
          {folded ? <ChevronRight size={14} strokeWidth={1.8} /> : <ChevronDown size={14} strokeWidth={1.8} />}
        </button>
      ) : (
        <span aria-hidden className="inline-block size-5 shrink-0" />
      )}
      <span className="min-w-0 flex-1">{children}</span>
    </span>
  );
}
