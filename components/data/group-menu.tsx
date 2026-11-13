"use client";

import { useState } from "react";
import { Popover } from "radix-ui";
import { Check, ChevronRight, Rows3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { optionRow, optionValue, panel } from "./filter-sort";
import type { GroupBy } from "@/server/kernel/query";
import type { Column } from "./types";

// Group by (0.4, M20): the step, a person, choice or linked row, a person's team, or a date by month.

export function groupOptions(columns: Column[]): { label: string; short: string; value: GroupBy }[] {
  const out: { label: string; short: string; value: GroupBy }[] = [];
  for (const c of columns) {
    if (c.hintFor) continue;
    if (c.type === "step" || c.type === "choice" || c.type === "link") out.push({ label: c.name, short: c.name, value: { column: c.id } });
    if (c.type === "person") out.push({ label: c.name, short: c.name, value: { column: c.id } }, { label: `Team (of ${c.name})`, short: "team", value: { column: c.id, by: "team" } });
    if (c.type === "date" || c.type === "datetime") out.push({ label: `${c.name} by month`, short: "month", value: { column: c.id, by: "month" } });
  }
  return out;
}

const same = (a: GroupBy | null, b: GroupBy | null) => (a?.column ?? null) === (b?.column ?? null) && (a?.by ?? null) === (b?.by ?? null);

export function GroupMenu({ columns, value, onChange }: { columns: Column[]; value: GroupBy | null; onChange: (g: GroupBy | null) => void }) {
  const [open, setOpen] = useState(false);
  const options = groupOptions(columns);
  const current = options.find((o) => same(o.value, value));
  const item = (on: boolean) => cn("flex h-8 w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 text-left text-[15px] hover:bg-active-nav", on && "bg-primary-light");
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={optionRow}>
        <Rows3 size={14} strokeWidth={1.8} className="text-muted" />
        Group
        <span className={optionValue}>{current?.short}</span>
        <ChevronRight size={14} strokeWidth={1.8} className="text-muted" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="left" align="start" sideOffset={8} className={cn(panel, "w-64")}>
          <div role="menu" aria-label="Group by">
            <button type="button" role="menuitemradio" aria-checked={!value} onClick={() => (onChange(null), setOpen(false))} className={item(!value)}>
              <span className="flex-1">No grouping</span>
              {!value ? <Check size={14} strokeWidth={2} className="text-primary-text" /> : null}
            </button>
            {options.map((o) => {
              const on = same(o.value, value);
              return (
                <button key={`${o.value.column}:${o.value.by ?? ""}`} type="button" role="menuitemradio" aria-checked={on} onClick={() => (onChange(o.value), setOpen(false))} className={item(on)}>
                  <span className="flex-1">{o.label}</span>
                  {on ? <Check size={14} strokeWidth={2} className="text-primary-text" /> : null}
                </button>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
