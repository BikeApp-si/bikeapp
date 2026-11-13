"use client";

import { useState } from "react";
import { Popover } from "radix-ui";
import { ArrowDown, ArrowUp, LoaderCircle, Sparkles, X } from "lucide-react";
import { inputText, parseInput } from "@/lib/parse";
import { useFormats } from "@/components/formats";
import { DatePickerButton } from "@/components/date-picker";
import { displayValue, US, type Formats } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useModel } from "@/components/no-model";
import { NO_MODEL } from "@/lib/messages";
import type { Filter, Sort } from "@/server/kernel/query";
import type { Column, Person, SheetView } from "./types";

const PICKED = new Set(["step", "choice", "person"]);
const TEXT = new Set(["text", "long_text", "email", "phone", "url"]);
const RANGE = new Set(["number", "money", "percent", "days", "date"]);

// Columns the table can filter and sort by: stored ones the kernel can compare (worked-out columns and files are left out).
export const usable = (c: Column) => PICKED.has(c.type) || TEXT.has(c.type) || RANGE.has(c.type);

export const tool =
  "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[6px] px-2 text-[14.5px] text-muted outline-none hover:bg-active-nav hover:text-ink focus-visible:ring-3 focus-visible:ring-focus data-[state=open]:bg-active-nav data-[state=open]:text-ink";
// One row of the Options menu, opening its own menu to the side.
export const optionRow =
  "flex h-8 w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 text-left text-[15px] text-ink outline-none hover:bg-active-nav focus-visible:bg-active-nav data-[state=open]:bg-active-nav";
export const optionValue = "min-w-0 flex-1 truncate text-right text-[14px] text-muted";

export const panel = "z-50 w-72 rounded-[8px] border border-line bg-white p-2 shadow-[0_8px_24px_rgba(15,23,43,.12)]";

function optionsOf(c: Column, sheet: SheetView, people: Person[]) {
  if (c.type === "step") return sheet.steps.map((s) => ({ id: s.id, label: s.name }));
  if (c.type === "choice") return (c.options ?? []).map((o) => ({ id: o.id, label: o.name }));
  return people.map((p) => ({ id: p.id, label: p.name }));
}

// "Status: Active, Signed", "Customer has kova", "Value a year $10,000 – $40,000".
export function filterText(f: Filter, sheet: SheetView, people: Person[], fmt: Formats = US): string {
  const c = sheet.columns.find((x) => x.id === f.column)!;
  if (f.op === "in") return `${c.name}: ${f.values.map((v) => optionsOf(c, sheet, people).find((o) => o.id === v)?.label ?? "").join(", ")}`;
  if (f.op === "contains") return `${c.name} has ${f.text}`;
  const show = (v: unknown) => (v === null || v === undefined ? "" : displayValue(c, v, {}, fmt));
  if (f.from != null && f.to != null) return `${c.name} ${show(f.from)} – ${show(f.to)}`;
  return f.from != null ? `${c.name} from ${show(f.from)}` : `${c.name} up to ${show(f.to)}`;
}

// Plain words (0.4, M21): the request goes to the kernel, which answers with filters it has checked and what it
// couldn't use, in plain words.
export type WordsReply = { ok: true; filters: Filter[]; couldNot: string[] } | { ok: false; error: string };

export function FilterButton({ sheet, people, onAdd, onWords }: { sheet: SheetView; people: Person[]; onAdd: (f: Filter[]) => void; onWords?: (text: string) => Promise<WordsReply> }) {
  const model = useModel();
  const fmt = useFormats();
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState("");
  const [asking, setAsking] = useState(false);
  const [said, setSaid] = useState<string[]>([]);
  const [column, setColumn] = useState<Column | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reset = () => (setColumn(null), setPicked([]), setText(""), setFrom(""), setTo(""), setError(null), setWords(""), setSaid([]));

  async function ask() {
    if (!onWords || !words.trim() || asking) return;
    setAsking(true);
    // A call that throws (Bike stopped mid-way) ends the same as a refusal, so the box never stays busy.
    const r = await onWords(words).catch(() => ({ ok: false as const, error: "Bike couldn't turn that into filters. Try saying it differently." }));
    setAsking(false);
    if (!r.ok) return setSaid([r.error]);
    if (r.filters.length) onAdd(r.filters);
    // Done when everything was used; otherwise the menu stays open with what wasn't.
    if (!r.couldNot.length) return (setOpen(false), reset());
    setWords("");
    setSaid(r.couldNot);
  }

  function apply() {
    if (!column) return;
    if (PICKED.has(column.type)) {
      if (!picked.length) return;
      onAdd([{ column: column.id, op: "in", values: picked }]);
    } else if (TEXT.has(column.type)) {
      if (!text.trim()) return;
      onAdd([{ column: column.id, op: "contains", text: text.trim() }]);
    } else {
      const a = parseInput(column.type, from, column.name, fmt);
      const b = parseInput(column.type, to, column.name, fmt);
      if (!a.ok || !b.ok) return setError(!a.ok ? a.error : !b.ok ? b.error : null);
      if (a.value === null && b.value === null) return;
      onAdd([{ column: column.id, op: "between", from: a.value as number | string | null, to: b.value as number | string | null }]);
    }
    setOpen(false);
    reset();
  }

  const input = "h-8 w-full rounded-[6px] border border-line px-2 text-[15px] outline-none focus:border-primary";
  return (
    <Popover.Root open={open} onOpenChange={(o) => (setOpen(o), o || reset())}>
      <Popover.Trigger className={tool}>
        Filter
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className={cn(panel, !column && onWords && "w-96")}>
          {!column ? (
            <>
              {onWords && model.none ? (
                <div role="note" className="mb-1 border-b border-line px-2 pt-1 pb-2.5 text-[14.5px] leading-normal text-muted">
                  {NO_MODEL.filters}
                </div>
              ) : onWords ? (
                <div className="mb-1 flex flex-col gap-1.5 border-b border-line pb-2">
                  <label className="flex h-8 items-center gap-1.5 rounded-[6px] border border-line px-2 focus-within:border-primary">
                    {asking ? <LoaderCircle size={14} strokeWidth={1.8} className="shrink-0 animate-spin text-primary-text" /> : <Sparkles size={14} strokeWidth={1.8} className="shrink-0 text-primary-text" />}
                    <input
                      autoFocus
                      aria-label="Describe the rows"
                      value={words}
                      disabled={asking}
                      onChange={(e) => setWords(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void ask())}
                      placeholder={`Describe the ${sheet.row.many}…`}
                      className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[#90A1B9]"
                    />
                  </label>
                  {said.length ? (
                    <div role="status" className="flex flex-col gap-0.5 px-1 text-[13.5px] text-nav">
                      {said.map((s) => (
                        <span key={s}>{s}</span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {sheet.columns.filter(usable).map((c) => (
                <button key={c.id} type="button" onClick={() => setColumn(c)} className="flex h-8 w-full items-center rounded-[6px] px-2 text-left text-[15px] hover:bg-active-nav">
                  {c.name}
                </button>
              ))}
            </>
          ) : (
            <div className="flex flex-col gap-2">
              <span className="px-1 text-[13.5px] font-medium text-muted">{column.name}</span>
              {PICKED.has(column.type) ? (
                <div className="max-h-56 overflow-auto">
                  {optionsOf(column, sheet, people).map((o) => (
                    <label key={o.id} className="flex h-8 items-center gap-2 rounded-[6px] px-1 text-[15px] hover:bg-active-nav">
                      <input type="checkbox" className="size-4 accent-primary" checked={picked.includes(o.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, o.id] : p.filter((x) => x !== o.id)))} />
                      {o.label}
                    </label>
                  ))}
                </div>
              ) : TEXT.has(column.type) ? (
                <input autoFocus aria-label={`${column.name} has`} className={input} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && apply()} />
              ) : (
                <div className="flex items-center gap-2">
                  <RangeInput label="From" autoFocus column={column} value={from} onChange={setFrom} />
                  <RangeInput label="To" column={column} value={to} onChange={setTo} onEnter={apply} />
                </div>
              )}
              {error ? <span className="px-1 text-[13.5px] text-[#DC2626]">{error}</span> : null}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={reset} className="h-7 rounded-[6px] px-2.5 text-[15px] text-muted hover:bg-fill">
                  Back
                </button>
                <button type="button" onClick={apply} className="h-7 rounded-[6px] bg-primary px-2.5 text-[15px] font-medium text-white hover:bg-primary-hover">
                  Filter
                </button>
              </div>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function FilterChip({ text, onRemove }: { text: string; onRemove: () => void }) {
  return (
    <span className="inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-[4px] bg-primary-light pr-1 pl-2 text-[14px] text-primary-hover">
      {text}
      <button type="button" aria-label={`Remove ${text}`} onClick={onRemove} className="inline-flex size-4 items-center justify-center rounded-[3px] hover:bg-primary-border">
        <X size={12} strokeWidth={2} />
      </button>
    </span>
  );
}

export function SortButton({ sheet, sort, onChange }: { sheet: SheetView; sort: Sort | null; onChange: (s: Sort) => void }) {
  const [open, setOpen] = useState(false);
  const current = sort && sheet.columns.find((c) => c.id === sort.column);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={tool}>
        Sort
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className={cn(panel, "w-60")}>
          {sheet.columns.filter(usable).map((c) => {
            const on = sort?.column === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => (onChange({ column: c.id, dir: on && sort?.dir === "asc" ? "desc" : "asc" }), setOpen(false))}
                className={cn("flex h-8 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[15px] hover:bg-active-nav", on && "bg-primary-light")}
              >
                <span className="flex-1">{c.name}</span>
                {on ? sort?.dir === "asc" ? <ArrowUp size={14} strokeWidth={1.8} /> : <ArrowDown size={14} strokeWidth={1.8} /> : null}
              </button>
            );
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// One end of a range; a date's end has the calendar beside it.
function RangeInput({ label, column, value, onChange, onEnter, autoFocus }: { label: string; column: Column; value: string; onChange: (t: string) => void; onEnter?: () => void; autoFocus?: boolean }) {
  const field = (
    <input
      autoFocus={autoFocus}
      aria-label={label}
      placeholder={label}
      className={cn("min-w-0 flex-1 text-[15px] outline-none", column.type !== "date" && "h-8 w-full rounded-[6px] border border-line px-2 focus:border-primary")}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
    />
  );
  return <DateRangeEnd column={column} value={value} onChange={onChange} field={field} />;
}

function DateRangeEnd({ column, value, onChange, field }: { column: Column; value: string; onChange: (t: string) => void; field: React.ReactNode }) {
  const fmt = useFormats();
  if (column.type !== "date") return field;
  const parsed = parseInput("date", value, column.name, fmt);
  return (
    <div className="flex h-8 w-full items-center rounded-[6px] border border-line pr-1 pl-2 focus-within:border-primary">
      {field}
      <DatePickerButton value={parsed.ok && typeof parsed.value === "string" ? parsed.value : null} onPick={(iso) => onChange(inputText("date", iso, fmt))} />
    </div>
  );
}
