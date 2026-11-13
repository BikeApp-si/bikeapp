"use client";

import { useState } from "react";
import { Popover } from "radix-ui";
import { CalendarDays } from "lucide-react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";

const pad = (n: number) => String(n).padStart(2, "0");
const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// The calendar's colours and sizes in Bike's tokens.
const LOOK = {
  "--rdp-accent-color": "#1E90FF",
  "--rdp-accent-background-color": "#EFF7FF",
  "--rdp-today-color": "#1E90FF",
  "--rdp-day-height": "36px",
  "--rdp-day-width": "36px",
  "--rdp-day_button-height": "34px",
  "--rdp-day_button-width": "34px",
  "--rdp-nav-height": "36px",
  fontSize: 14.5,
} as React.CSSProperties;

// A calendar button inside a date field: picking a day fills the field (as YYYY-MM-DD); typing still works.
export function DatePickerButton({ value, onPick }: { value: string | null; onPick: (iso: string) => void }) {
  const [open, setOpen] = useState(false);
  const selected = value ? new Date(`${value.slice(0, 10)}T12:00:00`) : undefined;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" aria-label="Calendar" className="-mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-[6px] text-icon outline-none hover:bg-page focus-visible:ring-2 focus-visible:ring-focus">
          <CalendarDays size={15} strokeWidth={1.8} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="z-50 rounded-[10px] border border-line bg-white p-3 text-ink shadow-[0_8px_24px_rgba(15,23,43,.12)]">
          <DayPicker
            mode="single"
            style={LOOK}
            selected={selected}
            defaultMonth={selected}
            onSelect={(d) => {
              if (!d) return;
              onPick(isoOf(d));
              setOpen(false);
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
