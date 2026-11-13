"use client";

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Pill, stepTone } from "@/components/chips";
import { FieldInput, type FieldCtx } from "./field-input";
import type { Column, SheetView } from "./types";

// Working in the table (0.3, M18): the Undo bar after a change, and a new row added as a row of the table.

export type Undo = { text: string; run: () => Promise<void> };

// "Changed Start on Northwind · Undo", for 8 seconds. Undo is a change of its own, with its own Audit entry.
export function UndoBar({ undo, onDone }: { undo: Undo; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  // Eight seconds from each change, not from each redraw of the table.
  useEffect(() => {
    const t = setTimeout(() => done.current(), 8000);
    return () => clearTimeout(t);
  }, [undo]);
  return (
    <div role="status" className="fixed bottom-6 left-1/2 z-30 flex h-10 -translate-x-1/2 items-center gap-4 rounded-[8px] bg-ink pr-2 pl-4 text-[14.5px] text-white shadow-[0_12px_32px_rgba(15,23,43,.24)]">
      {undo.text}
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await undo.run();
          onDone();
        }}
        className="h-7 cursor-pointer rounded-[6px] px-2.5 font-medium text-primary-border hover:bg-white/10"
      >
        Undo
      </button>
    </div>
  );
}

// "+ New contract" under the last row: the questions asked when a row is added, as inputs in their cells; Tab moves
// across, Enter creates it, Esc puts it away. An ordinary create, with the same checks and rules.
export function NewRow({ sheet, columns, extra = 0, ctx, onCreate }: {
  sheet: SheetView;
  columns: Column[];
  extra?: number; // columns after the sheet's own (the admin's "+")
  ctx: FieldCtx;
  onCreate: (values: Record<string, unknown>) => Promise<string | null>; // the refusal, if any
}) {
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const row = useRef<HTMLTableRowElement>(null);
  const start = sheet.steps.find((s) => s.start);

  useEffect(() => {
    if (values && !Object.keys(values).length) row.current?.querySelector<HTMLElement>("input, button:not([tabindex='-1'])")?.focus();
  }, [values]);

  if (!values)
    return (
      <tr>
        <td className="w-10 !border-r-0 !px-0" />
        <td colSpan={columns.length + extra}>
          <button type="button" onClick={() => setValues({})} className="-ml-2 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[6px] px-2 text-[14.5px] text-muted hover:bg-fill hover:text-ink">
            <Plus size={14} strokeWidth={1.8} />
            {sheet.addAction}
          </button>
        </td>
      </tr>
    );

  async function create() {
    if (Object.values(errors).some(Boolean) || busy) return;
    setBusy(true);
    const refused = await onCreate(values!);
    setBusy(false);
    if (refused) return setProblem(refused);
    setValues(null);
    setErrors({});
    setProblem(null);
  }

  return (
    <>
      <tr
        ref={row}
        aria-label={`New ${sheet.row.one}`}
        className="bg-primary-light/40"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void create();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setValues(null);
            setProblem(null);
          }
        }}
      >
        <td />
        {columns.map((c) => (
          <td key={c.id} className="!py-1">
            {sheet.quick.includes(c.id) ? (
              <div className="flex min-w-36 [&>*]:!h-8 [&>*]:!text-[15px]">
                <FieldInput
                  column={c}
                  dropdown
                  value={values[c.id]}
                  ctx={ctx}
                  onChange={(v) => setValues((old) => ({ ...old, [c.id]: v }))}
                  onError={(e) => setErrors((old) => ({ ...old, [c.id]: e }))}
                />
              </div>
            ) : c.type === "step" && start ? (
              <Pill tone={stepTone(start)}>{start.name}</Pill>
            ) : null}
          </td>
        ))}
        {extra ? <td colSpan={extra} /> : null}
      </tr>
      {problem || Object.values(errors).some(Boolean) ? (
        <tr>
          <td colSpan={columns.length + 1 + extra} role="alert" className="text-[13.5px] text-[#DC2626]">
            {problem ?? Object.values(errors).find(Boolean)}
          </td>
        </tr>
      ) : null}
    </>
  );
}
