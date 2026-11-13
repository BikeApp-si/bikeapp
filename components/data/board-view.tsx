"use client";

import { useState } from "react";
import { Dialog } from "radix-ui";
import { Button } from "@/components/buttons";
import { Pill, stepTone } from "@/components/chips";
import { cn } from "@/lib/utils";
import { TableCell } from "./cell";
import { StepMenu } from "./step-menu";
import type { Column, Names, Person, Row, SheetView, Step } from "./types";

// A sheet as a board (0.4, M20): a column per step with its count, a card per row. Dragging a card asks the kernel
// which steps it may go to and lights those columns; dropping it is an ordinary move (an end step asks first); a move
// the kernel refuses leaves the card where it was, with the reason. The card's status pill moves it by keyboard.

export type BoardColumn = { step: string; count: number; rows: Row[] };
type Move = { id: string; name: string };

export function BoardView({ sheet, columns, cardColumns, ctx, openId, onOpen, loadMoves, onMove, titleOf }: {
  sheet: SheetView;
  columns: BoardColumn[];
  cardColumns: Column[]; // the answers a card shows under its title
  ctx: { names: Names; people: Map<string, Person>; steps: Step[] };
  openId: string | null;
  onOpen: (rowId: string) => void;
  loadMoves: (rowId: string) => Promise<Move[]>;
  onMove: (rowId: string, to: string) => Promise<string | null>; // the refusal, if any
  titleOf: (row: Row) => string;
}) {
  const [dragging, setDragging] = useState<{ row: Row; allowed: Set<string> | null } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ row: Row; step: Step } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const title = sheet.columns.find((c) => c.id === sheet.titleColumn);

  async function drop(stepId: string) {
    const d = dragging;
    setDragging(null);
    setOver(null);
    if (!d || d.row.stepId === stepId) return;
    const step = sheet.steps.find((s) => s.id === stepId)!;
    if (d.allowed && !d.allowed.has(stepId)) return setRefused(`${titleOf(d.row)} can't move to ${step.name} from here.`);
    if (step.end) return setConfirm({ row: d.row, step });
    await move(d.row, stepId);
  }
  async function move(row: Row, stepId: string) {
    const why = await onMove(row.id, stepId);
    setRefused(why);
  }

  return (
    <div className="flex flex-col gap-2 px-8">
      {refused ? (
        <div role="alert" aria-label="Move refused" className="flex items-center gap-3 rounded-[8px] border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-[14.5px] text-[#B91C1C]">
          <span className="flex-1">{refused}</span>
          <button type="button" onClick={() => setRefused(null)} className="cursor-pointer text-[14px] text-[#B91C1C] underline">
            OK
          </button>
        </div>
      ) : null}
      <div className="flex gap-2 overflow-x-auto pb-2" aria-label={`${sheet.name} by step`}>
        {columns.map((col) => {
          const step = sheet.steps.find((s) => s.id === col.step)!;
          const can = !dragging || dragging.row.stepId === col.step || !dragging.allowed || dragging.allowed.has(col.step);
          return (
            <section
              key={col.step}
              aria-label={step.name}
              onDragOver={(e) => {
                // Every column takes the drop, so one the card can't go to answers with the reason.
                if (!dragging) return;
                e.preventDefault();
                setOver(can ? col.step : null);
              }}
              onDragLeave={() => setOver((o) => (o === col.step ? null : o))}
              onDrop={(e) => (e.preventDefault(), void drop(col.step))}
              className={cn(
                "flex min-w-[180px] flex-1 basis-0 flex-col gap-1.5 rounded-[10px] border bg-page p-1.5 transition-colors",
                dragging && dragging.row.stepId !== col.step && can ? "border-primary-border bg-primary-light/60" : "border-line",
                dragging && !can && "opacity-45",
                over === col.step && "border-primary",
              )}
            >
              <header className="flex items-center gap-2 px-1 pt-0.5">
                <Pill tone={stepTone(step)}>{step.name}</Pill>
                <span className="text-[14px] text-muted">{col.count}</span>
              </header>
              {col.rows.map((row) => (
                <article
                  key={row.id}
                  draggable
                  aria-label={titleOf(row)}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", row.id);
                    setDragging({ row, allowed: null });
                    void loadMoves(row.id).then((m) => setDragging((d) => (d?.row.id === row.id ? { row, allowed: new Set(m.map((x) => x.id)) } : d)));
                  }}
                  onDragEnd={() => (setDragging(null), setOver(null))}
                  onClick={() => onOpen(row.id)}
                  className={cn(
                    "flex cursor-grab flex-col gap-1 rounded-[8px] border bg-white p-2 text-[14.5px] shadow-[0_1px_2px_rgba(15,23,43,.06)] hover:border-primary-border active:cursor-grabbing",
                    openId === row.id ? "border-primary" : "border-line",
                    dragging?.row.id === row.id && "opacity-50",
                  )}
                >
                  <span className="font-medium text-ink">{title ? <TableCell column={title} value={row.data[title.id]} ctx={ctx} /> : null}</span>
                  {cardColumns.map((c) =>
                    row.data[c.id] === null || row.data[c.id] === undefined || row.data[c.id] === "" ? null : (
                      <span key={c.id} className="flex items-center justify-between gap-2 text-[13px]">
                        <span className="min-w-0 truncate text-muted">{c.name}</span>
                        <span className="shrink-0">
                          <TableCell column={c} value={row.data[c.id]} ctx={ctx} />
                        </span>
                      </span>
                    ),
                  )}
                  {/* The status pill moves the card by keyboard. */}
                  <span onClick={(e) => e.stopPropagation()} className="pt-0.5">
                    <StepMenu key={String(row.stepId)} step={step} steps={sheet.steps} loadMoves={() => loadMoves(row.id)} onMove={(to) => move(row, to)} rowTitle={titleOf(row)} />
                  </span>
                </article>
              ))}
              {col.count > col.rows.length ? <span className="px-1 text-[13.5px] text-muted">{col.count - col.rows.length} more</span> : null}
            </section>
          );
        })}
      </div>
      {confirm ? (
        <Dialog.Root open onOpenChange={(o) => !o && setConfirm(null)}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-[rgba(15,23,43,.32)]" />
            <Dialog.Content className="fixed top-1/2 left-1/2 z-50 flex w-[420px] -translate-x-1/2 -translate-y-1/2 flex-col gap-3.5 rounded-[12px] bg-white p-5 shadow-[0_24px_48px_rgba(15,23,43,.2)] outline-none">
              <Dialog.Title className="m-0 text-base font-semibold">
                Move {titleOf(confirm.row)} to {confirm.step.name}?
              </Dialog.Title>
              <Dialog.Description className="m-0 text-[15px] leading-[1.55] text-nav">This ends it, and it can&apos;t be moved on.</Dialog.Description>
              <div className="flex justify-end gap-2">
                <Button onClick={() => setConfirm(null)}>Cancel</Button>
                <Button kind="primary" onClick={() => (setConfirm(null), void move(confirm.row, confirm.step.id))}>
                  Move to {confirm.step.name}
                </Button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </div>
  );
}
