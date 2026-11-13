"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FileText, Upload } from "lucide-react";
import { Avatar, Pill, PersonChip, stepTone } from "@/components/chips";
import { useGrow } from "@/components/grow";
import { Picker } from "@/components/picker";
import { DatePickerButton } from "@/components/date-picker";
import { formatMoneyTyping, inputText, parseInput } from "@/lib/parse";
import { currencySign } from "@/lib/format";
import { useFormats } from "@/components/formats";
import { cn } from "@/lib/utils";
import { checkValue } from "@/server/kernel/values";
import { linkOptions, uploadFile } from "@/app/ws/[ws]/(app)/c/[cap]/actions";
import type { Column, Names, Person, Step } from "./types";

export type FieldCtx = {
  capId: string;
  people: Person[];
  names: Names;
  steps: Step[];
  onFileName: (id: string, name: string) => void;
};

const box =
  "flex h-10 w-full flex-1 items-center gap-2 rounded-[6px] border border-line bg-white px-3 text-[16px] text-ink shadow-[0_1px_2px_rgba(0,0,0,.04)] focus-within:border-primary focus-within:ring-3 focus-within:ring-focus";

const large = "h-10 px-3 text-[16px]";
// A question row's input (L2): no box until it has focus, its text lined up with the row's values.
const flatBox =
  "-ml-2.5 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[6px] border border-transparent bg-transparent px-2.5 text-[14.5px] text-ink focus-within:border-primary focus-within:bg-white focus-within:ring-3 focus-within:ring-focus";
const flatPicker =
  "-ml-2.5 h-8 border-transparent bg-transparent px-2.5 text-[14.5px] shadow-none focus-visible:border-primary focus-visible:bg-white focus-visible:ring-3 focus-visible:ring-focus data-[state=open]:bg-white [&>svg]:opacity-0 hover:[&>svg]:opacity-100 focus-visible:[&>svg]:opacity-100 data-[state=open]:[&>svg]:opacity-100";
const PILLS = 6;

// One field of a form, by column type, checked as the person types against the same rules the kernel uses.
// Text is kept as typed; the stored value goes up through onChange once it reads.
// dropdown: choices as a list, never pills (a table cell, #5); "open" opens it at once (a cell clicked to change it).
export function FieldInput({ column, value, onChange, onError, ctx, placeholder, flat, dropdown }: {
  column: Column;
  value: unknown;
  onChange: (v: unknown) => void;
  onError: (error: string | null) => void;
  ctx: FieldCtx;
  placeholder?: string;
  flat?: boolean;
  dropdown?: boolean | "open";
}) {
  const { type, name } = column;
  const pickerLook = flat ? flatPicker : large;
  // People with their initials and title; the one picked shows as their chip.
  if (type === "person") {
    const picked = ctx.people.find((p) => p.id === value);
    return (
      <Picker
        label={name}
        value={(value as string) ?? null}
        onChange={onChange}
        placeholder="Pick someone"
        className={pickerLook}
        options={ctx.people.map((p) => ({
          id: p.id,
          label: p.name,
          hint: p.title,
          node: p.id === picked?.id ? <PersonChip name={p.name} tint={p.tint} /> : (
            <span className="flex items-center gap-2">
              <Avatar name={p.name} tint={p.tint} size={20} />
              {p.name}
            </span>
          ),
        }))}
      />
    );
  }
  // A few choices as pills to click; more as a list with a search box. In the table always the list (#5).
  if (type === "choice")
    return !dropdown && (column.options ?? []).length <= PILLS ? (
      <ChoicePills column={column} value={(value as string) ?? null} onChange={onChange} flat={flat} />
    ) : (
      <Picker label={name} value={(value as string) ?? null} onChange={onChange} placeholder="Pick one" className={pickerLook} defaultOpen={dropdown === "open"} options={(column.options ?? []).map((o) => ({ id: o.id, label: o.name }))} />
    );
  if (type === "link") return <LinkInput column={column} value={value as string | null} onChange={onChange} ctx={ctx} className={pickerLook} />;
  if (type === "file") return <FileInput column={column} value={value as string | null} onChange={onChange} onError={onError} ctx={ctx} flat={flat} />;
  if (type === "step") {
    const step = ctx.steps.find((s) => s.id === value);
    return (
      <span className={flat ? "flex h-8 items-center" : box}>
        <Pill tone={stepTone(step)}>{step?.name ?? ""}</Pill>
      </span>
    );
  }
  return <TextInput column={column} value={value} onChange={onChange} onError={onError} placeholder={placeholder} flat={flat} />;
}

// Up to six choices as pills (0.3): click one, or move with the arrow keys; Tab leaves. Clicking the picked one again
// clears it, unless the question must be answered.
function ChoicePills({ column, value, onChange, flat }: { column: Column; value: string | null; onChange: (v: unknown) => void; flat?: boolean }) {
  const options = column.options ?? [];
  const pills = useRef<(HTMLButtonElement | null)[]>([]);
  const at = options.findIndex((o) => o.id === value);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const j = (i + step + options.length) % options.length;
    pills.current[j]?.focus();
    onChange(options[j]!.id);
  };
  return (
    <div role="radiogroup" aria-label={column.name} aria-required={column.required || undefined} className="flex flex-wrap gap-2">
      {options.map((o, i) => (
        <button
          key={o.id}
          ref={(el) => {
            pills.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          tabIndex={(at < 0 ? i === 0 : i === at) ? 0 : -1}
          onClick={() => onChange(o.id === value && !column.required ? null : o.id)}
          onKeyDown={(e) => onKey(e, i)}
          className={cn(
            "cursor-pointer rounded-full border outline-none focus-visible:ring-3 focus-visible:ring-focus",
            flat ? "h-[30px] px-3 text-[14.5px]" : "h-10 px-4 text-[15px]",
            o.id === value ? "border-primary bg-primary-light font-medium text-primary-hover" : "border-line bg-white text-ink hover:bg-page",
          )}
        >
          {o.name}
        </button>
      ))}
    </div>
  );
}

function TextInput({ column, value, onChange, onError, placeholder, flat }: { column: Column; value: unknown; onChange: (v: unknown) => void; onError: (e: string | null) => void; placeholder?: string; flat?: boolean }) {
  const fmt = useFormats();
  const [text, setText] = useState(() => inputText(column.type, value, fmt));
  const money = column.type === "money" || column.type === "money_range";
  const field = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  useGrow(area, text, 12);
  // Amounts get their thousands separators as typed; the cursor stays after the same digits.
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current === null || !field.current) return;
    field.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [text]);
  const read = (t: string) => {
    const parsed = parseInput(column.type, t, column.name, fmt);
    if (!parsed.ok) return onError(parsed.error);
    const checked = checkValue(column, parsed.value);
    if (!checked.ok) return onError(checked.error);
    onError(null);
    onChange(parsed.value);
  };
  const common = {
    "aria-label": column.name,
    "aria-required": column.required || undefined,
    value: text,
    placeholder: placeholder ?? (column.type === "date" ? "Pick a date" : money ? "0" : undefined),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      let t = e.target.value;
      if (money && e.target instanceof HTMLInputElement) {
        const f = formatMoneyTyping(t, e.target.selectionStart ?? t.length, fmt.grouping);
        t = f.text;
        caret.current = f.caret;
      }
      setText(t);
      read(t);
    },
    // Dates and amounts settle into their usual form when the field is left.
    onBlur: () => {
      const parsed = parseInput(column.type, text, column.name, fmt);
      if (parsed.ok && parsed.value !== null) setText(inputText(column.type, parsed.value, fmt));
    },
  };
  // A date from the calendar, as if typed (a date and time keeps its time, or starts at 9:00).
  const dated = column.type === "date" || column.type === "datetime";
  const picked = (() => {
    const parsed = dated ? parseInput(column.type, text, column.name, fmt) : null;
    return parsed?.ok && typeof parsed.value === "string" ? parsed.value.slice(0, 10) : null;
  })();
  const pick = (iso: string) => {
    const time = column.type === "datetime" ? (/(\d{1,2}:\d{2})$/.exec(text)?.[1] ?? "9:00") : null;
    const t = time ? `${inputText("date", iso, fmt)} ${time}` : inputText("date", iso, fmt);
    setText(t);
    read(t);
  };
  if (column.type === "long_text")
    return <textarea ref={area} {...common} rows={flat ? 1 : 2} className={cn(flat ? flatBox : box, "h-auto resize-none leading-[1.5] outline-none placeholder:text-[#90A1B9]", flat ? "py-1" : "py-2")} />;
  return (
    <label className={cn(flat ? flatBox : box, "group/box")}>
      {money ? <span className={cn(text ? "text-ink" : "text-[#90A1B9]")}>{currencySign(fmt)}</span> : null}
      <input ref={field} {...common} className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[#90A1B9]" />
      {dated ? (
        <span className={cn("inline-flex", flat && "opacity-0 group-hover/box:opacity-100 group-focus-within/box:opacity-100 has-[[data-state=open]]:opacity-100")}>
          <DatePickerButton value={picked} onPick={pick} />
        </span>
      ) : null}
    </label>
  );
}

function LinkInput({ column, value, onChange, ctx, className }: { column: Column; value: string | null; onChange: (v: unknown) => void; ctx: FieldCtx; className: string }) {
  const [options, setOptions] = useState<{ id: string; label: string }[]>(value ? [{ id: value, label: ctx.names.rows[value] ?? "" }] : []);
  useEffect(() => {
    if (!column.link) return;
    void linkOptions(column.link.capability ?? ctx.capId, column.link.sheet).then((r) => r.ok && setOptions(r.options));
  }, [column.link, ctx.capId]);
  return <Picker label={column.name} value={value} onChange={onChange} placeholder="Pick one" className={className} options={options} />;
}

// A file as a drop zone (0.3): drop it, or open the file picker by click, Enter or Space. Once uploaded (and checked
// for viruses) an image shows small, any other file as its name; Replace, and Remove unless it must be answered.
function FileInput({ column, value, onChange, onError, ctx, flat }: { column: Column; value: string | null; onChange: (v: unknown) => void; onError: (e: string | null) => void; ctx: FieldCtx; flat?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(file.name);
    const form = new FormData();
    form.set("file", file);
    const r = await uploadFile(form);
    setBusy(null);
    if (input.current) input.current.value = "";
    if (!r.ok) return onError(r.error);
    onError(null);
    ctx.onFileName(r.id, r.name);
    onChange(r.id);
  };
  const name = value ? (ctx.names.files[value] ?? "File") : null;
  const image = !!name && /\.(png|jpe?g)$/i.test(name);
  const choose = () => input.current?.click();
  const drop = {
    onDragOver: (e: React.DragEvent) => (e.preventDefault(), setOver(true)),
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => (e.preventDefault(), setOver(false), void pick(e.dataTransfer.files[0])),
  };
  const file = <input ref={input} type="file" hidden accept=".pdf,.docx,.xlsx,.csv,.png,.jpg,.jpeg" onChange={(e) => void pick(e.target.files?.[0])} />;
  if (value && !busy)
    return (
      <div role="group" aria-label={column.name} {...drop} className={cn(flat ? "flex w-full items-center gap-2 rounded-[6px]" : "flex w-full items-center gap-3 rounded-[8px] border border-line bg-white p-2 pr-3", over && "border-primary bg-primary-light")}>
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element -- an uploaded file, served by the files route to whoever may see it
          <img src={`/files/${value}`} alt="" className={cn("shrink-0 rounded-[6px] border border-line object-cover", flat ? "size-7" : "size-14")} />
        ) : (
          <span className={cn("flex shrink-0 items-center justify-center rounded-[6px] text-icon", !flat && "size-10 bg-fill")}>
            <FileText size={flat ? 14 : 18} strokeWidth={1.8} />
          </span>
        )}
        <span className={cn("min-w-0 flex-1 truncate text-ink", flat ? "text-[14.5px]" : "text-[15px]")}>
          {name}
        </span>
        <button type="button" onClick={choose} className="cursor-pointer text-[14px] text-primary-text hover:text-primary-hover">
          Replace
        </button>
        {!column.required ? (
          <button type="button" onClick={() => onChange(null)} className="cursor-pointer text-[14px] text-muted hover:text-ink">
            Remove
          </button>
        ) : null}
        {file}
      </div>
    );
  return (
    <button
      type="button"
      aria-label={column.name}
      disabled={!!busy}
      onClick={choose}
      {...drop}
      className={cn(
        flat
          ? "-ml-2.5 flex h-8 min-w-0 flex-1 cursor-pointer items-center rounded-[6px] border border-transparent px-2.5 text-[14.5px] text-[#90A1B9] outline-none focus-visible:border-primary focus-visible:bg-white focus-visible:ring-3 focus-visible:ring-focus disabled:cursor-default"
          : "flex min-h-14 w-full cursor-pointer flex-col items-center justify-center gap-1 rounded-[8px] border border-dashed border-[#CAD5E2] bg-page px-3 py-3 text-[15px] text-nav outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-focus disabled:cursor-default",
        over && "border-primary bg-primary-light",
      )}
    >
      {busy ? (
        <span className="truncate">
          {busy} <span className="text-muted">· Uploading…</span>
        </span>
      ) : (
        <span className="flex items-center gap-2">
          {flat ? null : <Upload size={16} strokeWidth={1.8} className="text-icon" />}
          <span>
            Drop a file here or <span className="text-primary-text">choose one</span>
          </span>
        </span>
      )}
      {file}
    </button>
  );
}
