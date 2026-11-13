"use client";

import { useRef, useState } from "react";
import { Popover } from "radix-ui";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type Option = { id: string; label: string; node?: React.ReactNode; hint?: string | null };

// Pick one from a list (a person, a choice, a linked row). A search box shows when the list is long. By keyboard:
// ↓, Enter or Space opens it, ↑ ↓ move, Enter picks, Esc closes, typing goes to the search box.
export function Picker({
  value,
  options,
  onChange,
  placeholder,
  label,
  className,
  trigger,
  defaultOpen,
}: {
  value: string | null;
  options: Option[];
  onChange: (id: string | null) => void;
  placeholder?: string;
  label: string;
  className?: string;
  trigger?: React.ReactNode;
  defaultOpen?: boolean; // open as soon as it's drawn (a table cell clicked to change it, #5)
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [q, setQ] = useState("");
  const picked = options.find((o) => o.id === value);
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase())) : options;
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const items = () => [...(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
  function onKey(e: React.KeyboardEvent) {
    // The list is in a portal: its keys stay here, not in the form behind it (Enter there goes to the next question).
    if (e.key === "Enter") e.stopPropagation();
    const all = items();
    const i = all.indexOf(document.activeElement as HTMLElement);
    const go = (j: number) => (e.preventDefault(), all[Math.max(0, Math.min(j, all.length - 1))]?.focus());
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") i <= 0 && search.current ? (e.preventDefault(), search.current.focus()) : go(i - 1);
    else if (e.key === "Home" && i >= 0) go(0);
    else if (e.key === "End" && i >= 0) go(all.length - 1);
    else if (e.key === "Enter" && document.activeElement === search.current && all[0]) (e.preventDefault(), all[0].click());
    else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && search.current && document.activeElement !== search.current) search.current.focus();
  }
  return (
    <Popover.Root open={open} onOpenChange={(o) => (setOpen(o), setQ(""))}>
      <Popover.Trigger asChild>
        {trigger ?? (
          <button
            type="button"
            aria-label={label}
            onKeyDown={(e) => e.key === "ArrowDown" && (e.preventDefault(), setOpen(true))}
            className={cn(
              "flex h-[34px] w-full flex-1 items-center gap-2 rounded-[6px] border border-line bg-white px-2.5 text-left text-[15px] shadow-[0_1px_2px_rgba(0,0,0,.04)] outline-none data-[state=open]:border-primary data-[state=open]:ring-3 data-[state=open]:ring-focus",
              className,
            )}
          >
            <span className={cn("flex min-w-0 flex-1 items-center gap-1.5 truncate", !picked && "text-[#90A1B9]")}>{picked ? (picked.node ?? picked.label) : placeholder}</span>
            <ChevronDown size={14} strokeWidth={1.8} className="text-muted" />
          </button>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          onKeyDown={onKey}
          // Opened: the search box, else the picked option, else the first.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (search.current ?? items().find((x) => x.getAttribute("aria-selected") === "true") ?? items()[0])?.focus();
          }}
          className="z-50 max-h-72 w-(--radix-popover-trigger-width) min-w-56 overflow-auto rounded-[8px] border border-line bg-white p-1 shadow-[0_8px_24px_rgba(15,23,43,.12)]">
          {options.length > 8 ? (
            <input
              ref={search}
              aria-label={`Search ${label.toLowerCase()}`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              className="mb-1 h-8 w-full rounded-[6px] border border-line px-2 text-[15px] outline-none focus:border-primary"
            />
          ) : null}
          <div ref={list} role="listbox" aria-label={label}>
            {shown.map((o) => (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={o.id === value}
                onClick={() => (onChange(o.id), setOpen(false))}
                className={cn("flex h-8 w-full items-center gap-1.5 rounded-[6px] px-2 text-left text-[15px] text-ink outline-none hover:bg-active-nav focus-visible:bg-active-nav", o.id === value && "bg-primary-light")}
              >
                {o.node ?? o.label}
                {o.hint ? <span className="ml-auto truncate pl-3 text-[13.5px] text-muted">{o.hint}</span> : null}
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
