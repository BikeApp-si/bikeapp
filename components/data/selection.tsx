"use client";

import { useEffect, useState } from "react";
import { Dialog } from "radix-ui";
import { ArrowRight, Trash2, User, X } from "lucide-react";
import { Button, IconButton } from "@/components/buttons";
import { PersonChip } from "@/components/chips";
import { Picker } from "@/components/picker";
import { displayValue } from "@/lib/format";
import { useFormats } from "@/components/formats";
import { cn } from "@/lib/utils";
import { bulkChange, commonMoves, previewDelete, removeRows } from "@/app/ws/[ws]/(app)/c/[cap]/actions";
import type { Person, SheetView } from "./types";

const barButton = "inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[6px] px-3.5 text-[15px] font-medium text-ink hover:bg-fill";

// Select many (7d): "3 selected", a change for each person column, Move to step, Delete, ×. One change, one Audit entry.
export function SelectionBar({ sheet, ids, people, onDone, onDelete, onClear }: {
  sheet: SheetView;
  ids: string[];
  people: Person[];
  onDone: (error?: string) => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const [moves, setMoves] = useState<{ id: string; name: string }[]>([]);
  const key = ids.join(",");
  useEffect(() => {
    void commonMoves(key.split(",")).then((r) => setMoves(r.ok ? r.moves : []));
  }, [key]);

  const personCols = sheet.canEdit ? sheet.columns.filter((c) => c.type === "person") : [];
  const run = async (change: Parameters<typeof bulkChange>[1]) => {
    const r = await bulkChange(ids, change);
    onDone(r.ok ? undefined : r.error);
  };

  return (
    <div className="absolute bottom-24 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-[10px] border border-line bg-white py-1.5 pr-1.5 pl-3.5 text-[15px] whitespace-nowrap shadow-[0_8px_24px_rgba(15,23,43,.12)]">
      <span className="mr-2 font-medium">{ids.length} selected</span>
      {personCols.map((c) => (
        <Picker
          key={c.id}
          label={`Change ${c.name.toLowerCase()}`}
          value={null}
          onChange={(id) => id && void run({ values: { [c.id]: id } })}
          options={people.map((p) => ({ id: p.id, label: p.name, node: <PersonChip name={p.name} tint={p.tint} /> }))}
          trigger={
            <button type="button" className={barButton}>
              <User size={16} strokeWidth={1.8} />
              Change {c.name.toLowerCase()}
            </button>
          }
        />
      ))}
      {sheet.steps.length ? (
        <Picker
          label="Move to step"
          value={null}
          onChange={(id) => id && void run({ step: id })}
          options={moves.map((m) => ({ id: m.id, label: m.name }))}
          trigger={
            <button type="button" className={barButton} disabled={!moves.length}>
              <ArrowRight size={16} strokeWidth={1.8} />
              Move to step
            </button>
          }
        />
      ) : null}
      {sheet.canDelete ? (
        <button type="button" onClick={onDelete} className={cn(barButton, "text-[#DC2626]")}>
          <Trash2 size={16} strokeWidth={1.8} />
          Delete
        </button>
      ) : null}
      <span className="mx-1 h-5 w-px bg-line" />
      <IconButton aria-label="Clear selection" onClick={onClear}>
        <X size={16} strokeWidth={1.8} />
      </IconButton>
    </div>
  );
}

// Delete (7e): the rows by name and amount, what goes with them, "This can't be undone", Delete N rows.
export function DeleteRowsDialog({ sheet, ids, onClose, onDeleted }: { sheet: SheetView; ids: string[]; onClose: () => void; onDeleted: () => void }) {
  const [preview, setPreview] = useState<{ rows: { id: string; title: string; data: Record<string, unknown> }[]; alsoDeleted: { one: string; many: string; count: number }[]; alsoEmptied: { one: string; many: string; column: string; count: number }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fmt = useFormats();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void previewDelete(ids).then((r) => (r.ok ? setPreview(r) : setError(r.error)));
  }, [ids]);

  const amount = sheet.columns.find((c) => c.type === "money");
  const n = ids.length;
  const words = n === 1 ? sheet.row.one : sheet.row.many;
  const also = preview?.alsoDeleted.map((a) => `${a.count} ${a.count === 1 ? a.one : a.many}`).join(" and ");
  // A pick from a list (G1): "3 expenses stay, with Cost centre left empty."
  const kept = preview?.alsoEmptied.map((e) => `${e.count} ${e.count === 1 ? e.one : e.many} ${e.count === 1 ? "stays" : "stay"}, with ${e.column} left empty. `).join("");

  async function remove() {
    setBusy(true);
    const r = await removeRows(ids);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onDeleted();
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[rgba(15,23,43,.32)]" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 flex w-[440px] -translate-x-1/2 -translate-y-1/2 flex-col gap-3.5 rounded-[12px] bg-white p-5 shadow-[0_24px_48px_rgba(15,23,43,.2)] outline-none">
          <Dialog.Title className="m-0 text-base font-semibold">
            Delete {n} {words}?
          </Dialog.Title>
          {preview ? (
            <>
              <div className="rounded-[8px] border border-line px-3 py-1 text-[15px]">
                {preview.rows.map((r, i) => (
                  <div key={r.id} className={i < preview.rows.length - 1 ? "flex border-b border-fill py-1.5" : "flex py-1.5"}>
                    <span className="flex-1 font-medium">{r.title}</span>
                    {amount ? <span className="text-muted">{displayValue(amount, r.data[amount.id], {}, fmt)}</span> : null}
                  </div>
                ))}
              </div>
              <Dialog.Description className="m-0 text-[15px] leading-[1.55] text-nav">
                {also ? `${n === 1 ? "Its" : "Their"} ${also} ${preview.alsoDeleted.reduce((s, a) => s + a.count, 0) === 1 ? "is" : "are"} deleted with ${n === 1 ? "it" : "them"}. ` : ""}
                {kept}
                The deletion is recorded in the Audit log.
              </Dialog.Description>
            </>
          ) : null}
          <div className="text-[15px] text-[#DC2626]">{error ?? "This can’t be undone."}</div>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button kind="danger" disabled={!preview || busy} onClick={() => void remove()}>
              Delete {n} {words}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
