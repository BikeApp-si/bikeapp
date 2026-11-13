"use client";

import { useState } from "react";
import { Popover } from "radix-ui";
import { Check, ChevronRight, Kanban, Table2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GroupBy } from "@/server/kernel/query";
import { ColumnsMenu, type Arrangement } from "./columns-menu";
import { optionRow, optionValue, panel, tool } from "./filter-sort";
import { GroupMenu } from "./group-menu";
import type { Column } from "./types";

export type Layout = "table" | "board";

// How the rows are shown (0.4, M19–M20), in one menu after Sort: table or board, grouping, columns. A pick closes it;
// Columns stays open while several are changed.
export function OptionsMenu({ columns, layouts, layout, onLayout, groupBy, onGroup, arrangement, onArrange, onReset }: {
  columns: Column[];
  layouts: boolean;
  layout: Layout;
  onLayout: (l: Layout) => void;
  groupBy: GroupBy | null;
  onGroup: (g: GroupBy | null) => void;
  arrangement: Arrangement;
  onArrange: (a: Arrangement) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={tool}>
        Options
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className={cn(panel, "w-60 p-1.5")}>
          {layouts ? <LayoutRow layout={layout} onPick={(l) => (onLayout(l), setOpen(false))} /> : null}
          {layout === "table" ? <GroupMenu columns={columns} value={groupBy} onChange={(g) => (onGroup(g), setOpen(false))} /> : null}
          <ColumnsMenu columns={columns} value={arrangement} onChange={onArrange} onReset={onReset} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function LayoutRow({ layout, onPick }: { layout: Layout; onPick: (l: Layout) => void }) {
  const Current = layout === "table" ? Table2 : Kanban;
  return (
    <Popover.Root>
      <Popover.Trigger className={optionRow}>
        <Current size={14} strokeWidth={1.8} className="text-muted" />
        Layout
        <span className={optionValue}>{layout === "table" ? "Table" : "Board"}</span>
        <ChevronRight size={14} strokeWidth={1.8} className="text-muted" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="left" align="start" sideOffset={8} className={cn(panel, "w-44 p-1.5")}>
          <div role="radiogroup" aria-label="Layout">
            {(["table", "board"] as const).map((l) => (
              <button key={l} type="button" role="radio" aria-checked={layout === l} onClick={() => onPick(l)} className={optionRow}>
                {l === "table" ? <Table2 size={14} strokeWidth={1.8} className="text-muted" /> : <Kanban size={14} strokeWidth={1.8} className="text-muted" />}
                <span className="flex-1">{l === "table" ? "Table" : "Board"}</span>
                {layout === l ? <Check size={14} strokeWidth={2} className="text-primary-text" /> : null}
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
