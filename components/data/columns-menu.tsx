"use client";

import { useState } from "react";
import { Popover } from "radix-ui";
import { ArrowDown, ArrowUp, ChevronRight, Columns3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { optionRow, panel } from "./filter-sort";
import type { Column } from "./types";

// The Columns menu (0.4, M19): show or hide each column, move it up or down, and freeze the first one. The table follows
// at once; the Data tab keeps it for the person (or for the open view).

export type Arrangement = { order: string[]; hidden: string[]; frozen: boolean };

export function ColumnsMenu({ columns, value, onChange, onReset }: { columns: Column[]; value: Arrangement; onChange: (a: Arrangement) => void; onReset: () => void }) {
  const [open, setOpen] = useState(false);
  const ordered = orderColumns(columns, value.order);
  const move = (i: number, by: number) => {
    const ids = ordered.map((c) => c.id);
    const [id] = ids.splice(i, 1);
    ids.splice(i + by, 0, id!);
    onChange({ ...value, order: ids });
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={optionRow}>
        <Columns3 size={14} strokeWidth={1.8} className="text-muted" />
        <span className="flex-1">Columns</span>
        <ChevronRight size={14} strokeWidth={1.8} className="text-muted" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="left" align="start" sideOffset={8} className={cn(panel, "w-72")}>
          <ul aria-label="Columns" className="m-0 flex list-none flex-col p-0">
            {ordered.map((c, i) => {
              const shown = !value.hidden.includes(c.id);
              return (
                <li key={c.id} className="flex h-8 items-center gap-2 rounded-[6px] px-1.5 hover:bg-page">
                  <label className="flex flex-1 cursor-pointer items-center gap-2 text-[15px]">
                    <input
                      type="checkbox"
                      checked={shown}
                      onChange={() => onChange({ ...value, hidden: shown ? [...value.hidden, c.id] : value.hidden.filter((x) => x !== c.id) })}
                      className="size-4 accent-primary"
                    />
                    {c.name}
                  </label>
                  <button type="button" aria-label={`Move ${c.name} up`} disabled={i === 0} onClick={() => move(i, -1)} className="inline-flex size-6 cursor-pointer items-center justify-center rounded-[4px] text-muted hover:bg-fill disabled:cursor-default disabled:opacity-30">
                    <ArrowUp size={13} strokeWidth={1.8} />
                  </button>
                  <button type="button" aria-label={`Move ${c.name} down`} disabled={i === ordered.length - 1} onClick={() => move(i, 1)} className="inline-flex size-6 cursor-pointer items-center justify-center rounded-[4px] text-muted hover:bg-fill disabled:cursor-default disabled:opacity-30">
                    <ArrowDown size={13} strokeWidth={1.8} />
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-2 flex items-center border-t border-line px-1.5 pt-2">
            <label className="flex flex-1 cursor-pointer items-center gap-2 text-[15px]">
              <input type="checkbox" checked={value.frozen} onChange={() => onChange({ ...value, frozen: !value.frozen })} className="size-4 accent-primary" />
              Freeze the first column
            </label>
            <button type="button" onClick={onReset} className="cursor-pointer text-[14px] text-primary-text hover:text-primary-hover">
              Reset
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// Columns in the person's order; any the order doesn't name (added since) keep their place at the end.
export function orderColumns(columns: Column[], order: string[]): Column[] {
  const known = order.map((id) => columns.find((c) => c.id === id)).filter((c): c is Column => !!c);
  return [...known, ...columns.filter((c) => !order.includes(c.id))];
}
