"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { FieldInput, type FieldCtx } from "./field-input";
import type { Column } from "./types";

// One question of a record, filled in or changed where it is (0.3). A click opens its own input; a pick (a person,
// a choice, a linked row, a file) saves at once, typed answers save on Enter or when the field is left, and Esc puts
// it back. The save is an ordinary one-value save: the same checks, rules and Audit entry as Save changes. A refused
// value keeps the input open with the reason under it.

const PICKED = new Set(["person", "choice", "link", "file"]);

// compact: in a table cell (0.3, M18): table-height inputs, the reason in a small card under the cell, and clicks kept
// from opening the row.
// copy: a record's row (L2): the text its copy button gives, shown with the edit button when the row is hovered.
export function InPlace({ column, value, display, empty, canEdit, ctx, onSave, compact, copy }: {
  column: Column;
  value: unknown;
  display: React.ReactNode;
  empty: boolean;
  canEdit: boolean;
  ctx: FieldCtx;
  onSave: (value: unknown) => Promise<string | null>; // the refusal, if any
  compact?: boolean;
  copy?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<unknown>(value);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // The input takes the cursor once it is drawn.
  useEffect(() => {
    if (open) box.current?.querySelector<HTMLElement>("input:not([type=file]), textarea, button:not([tabindex='-1'])")?.focus();
  }, [open]);
  // In a table an empty cell keeps its dash, named by its question for screen readers.
  const shown = empty && !compact ? <span className="text-[#90A1B9]">{column.name}</span> : empty ? <>{display}<span className="sr-only">{column.name}</span></> : display;

  const copyButton = copy ? <CopyValue name={column.name} text={copy} /> : null;
  if (!canEdit || column.type === "computed" || column.type === "step" || column.replacedBy)
    return (
      <span className="flex min-w-0 flex-1 items-center gap-2 text-ink">
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{display}</span>
        {copyButton}
      </span>
    );

  async function save(v: unknown) {
    if (error && v === draft) return;
    if (JSON.stringify(v ?? null) === JSON.stringify(value ?? null)) return close();
    setBusy(true);
    const refused = await onSave(v);
    setBusy(false);
    if (refused) return setError(refused);
    close();
  }
  function close() {
    setOpen(false);
    setError(null);
  }
  function start() {
    setDraft(value);
    setError(null);
    setOpen(true);
  }

  const keep = compact ? (e: React.SyntheticEvent) => e.stopPropagation() : undefined;
  if (!open)
    return (
      <span className="group flex min-w-0 flex-1 items-center gap-1 text-ink" onClick={keep}>
        {column.type === "file" && !empty ? (
          <span className="flex min-w-0 flex-1 items-center">{display}</span>
        ) : (
          <button
            type="button"
            onClick={start}
            className={cn(
              "flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-2 text-left focus-visible:outline-none [.text-right_&]:justify-end",
              compact ? "-mx-1.5 min-h-7 rounded-[4px] px-1.5 hover:bg-fill focus-visible:bg-fill" : "min-h-8 rounded-[6px] focus-visible:ring-3 focus-visible:ring-focus",
            )}
          >
            {shown}
          </button>
        )}
        {copyButton}
        {compact ? null : (
          <button type="button" aria-label={`Change ${column.name}`} onClick={start} className={ROW_BUTTON}>
            <Pencil size={14} strokeWidth={1.8} />
          </button>
        )}
      </span>
    );

  return (
    <div
      ref={box}
      onClick={keep}
      className={cn("flex flex-1 flex-col gap-1", compact ? "relative min-w-0" : "min-w-0", busy && "opacity-60")}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          // Puts it back without closing the panel.
          e.preventDefault();
          e.stopPropagation();
          close();
        } else if (e.key === "Enter" && !PICKED.has(column.type) && (column.type !== "long_text" || e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void save(draft);
        }
      }}
      onBlur={(e) => {
        // Leaving the field saves a typed answer; a calendar or list opened from it isn't leaving.
        const to = e.relatedTarget as HTMLElement | null;
        if (PICKED.has(column.type) || box.current?.contains(to) || to?.closest("[data-radix-popper-content-wrapper]")) return;
        void save(draft);
      }}
    >
      <div className={cn("flex", compact && "min-w-0 [&_input]:w-full [&_input]:min-w-0 [&>*]:!h-8 [&>*]:min-w-0 [&>*]:!text-[15px]")}>
        <FieldInput
          column={column}
          value={draft}
          ctx={ctx}
          flat={!compact}
          dropdown={compact ? "open" : undefined}
          onChange={(v) => {
            setDraft(v);
            if (PICKED.has(column.type)) void save(v);
          }}
          onError={setError}
        />
      </div>
      {error ? (
        <span
          role="alert"
          className={cn(
            "text-[13.5px] text-[#DC2626]",
            compact && "absolute top-full left-0 z-20 mt-1 w-72 rounded-[6px] border border-line bg-white px-2.5 py-1.5 whitespace-normal shadow-[0_8px_24px_rgba(15,23,43,.12)]",
          )}
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}

const ROW_BUTTON =
  "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[6px] border border-line bg-white text-icon opacity-0 outline-none group-hover/row:opacity-100 hover:text-ink focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-focus";

function CopyValue({ name, text }: { name: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${name}`}
      className={ROW_BUTTON}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.8} />}
    </button>
  );
}
