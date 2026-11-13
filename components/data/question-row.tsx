"use client";

import { useState } from "react";
import { AlignLeft, Calculator, Calendar, CalendarClock, ChevronDown, CircleDollarSign, File, Flag, Globe, Hash, Link2, Lock, Mail, Percent, Phone, Tag, Timer, Type, User, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Column } from "./types";

// A question's icon, from its type. Nothing in the capability file says it.
export const COLUMN_ICONS: Record<Column["type"], LucideIcon> = {
  text: Type,
  long_text: AlignLeft,
  number: Hash,
  money: CircleDollarSign,
  money_range: CircleDollarSign,
  percent: Percent,
  date: Calendar,
  datetime: CalendarClock,
  days: Timer,
  person: User,
  email: Mail,
  phone: Phone,
  url: Globe,
  file: File,
  choice: Tag,
  link: Link2,
  step: Flag,
  computed: Calculator,
};

// A column's icon: its type's, or a lock for a column kept from before, read only (M27, m27-d).
export const columnIcon = (c: Pick<Column, "type" | "replacedBy">): LucideIcon => (c.replacedBy ? Lock : COLUMN_ICONS[c.type]);

const FOCUSABLE = "input:not([type=file]), textarea, button:not([tabindex='-1'])";

// One row of a form or record, like a row of the sidebar: icon, label, value, and under the value its note.
// question: a form's row, which Enter moves between and whose label focuses its input.
export function QuestionRow({ icon: Icon, label, note, right, question, children }: {
  icon: LucideIcon;
  label: string;
  note?: React.ReactNode;
  right?: React.ReactNode;
  question?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div data-question={question ? "" : undefined} className="group/row -mx-2 flex min-h-9 items-start rounded-[8px] px-2 text-[14.5px] hover:bg-active-nav">
      <span
        onClick={question ? (e) => e.currentTarget.parentElement?.querySelector<HTMLElement>(FOCUSABLE)?.focus() : undefined}
        className="flex min-h-9 w-[164px] shrink-0 items-center gap-2 py-1.5 pr-2 leading-[1.3] text-muted"
      >
        <Icon size={16} strokeWidth={1.8} className="shrink-0 text-icon" />
        {label}
      </span>
      <div className="flex min-h-9 min-w-0 flex-1 flex-col justify-center py-0.5">
        <div className="flex min-w-0 items-center">{children}</div>
        {note}
      </div>
      {right ? <span className="flex h-9 shrink-0 items-center pl-2 text-[13px] text-muted">{right}</span> : null}
    </div>
  );
}

// A section that folds, under a small label like the sidebar's, with a straight line across the panel above it.
// open: stays open whatever was clicked, for a section with a message in it.
export function FormSection({ name, open, children }: { name: string | null; open?: boolean; children: React.ReactNode }) {
  const [folded, setFolded] = useState(false);
  const hidden = folded && !open;
  return (
    <section className="-mx-6 flex flex-col border-t border-line px-6 py-2.5 first:border-t-0">
      {name ? (
        <button
          type="button"
          aria-expanded={!hidden}
          onClick={() => setFolded(!folded)}
          className="flex h-8 cursor-pointer items-center justify-between text-[13.5px] font-medium text-muted outline-none hover:text-ink focus-visible:text-ink"
        >
          {name}
          <ChevronDown size={15} strokeWidth={1.8} className={cn("transition-transform", hidden && "-rotate-90")} />
        </button>
      ) : null}
      {hidden ? null : children}
    </section>
  );
}
