"use client";

import { useState } from "react";
import { Dialog } from "radix-ui";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/buttons";
import { Pill, stepTone } from "@/components/chips";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { Step } from "./types";

// A row's status as its coloured pill (0.3): clicking it lists the steps this person may move it to: the next step
// first, steps that end it (marked, and confirmed before moving), "Back to …" last. The kernel checks the move as
// always. No moves for this person: a plain pill. In a table the moves are fetched when the pill is opened.

type Move = { id: string; name: string };

export function StepMenu({
  step,
  steps,
  moves,
  loadMoves,
  onMove,
  rowTitle,
  suffix,
  large,
}: {
  step: Step | undefined;
  steps: Step[];
  moves?: Move[]; // known (the record panel)
  loadMoves?: () => Promise<Move[]>; // fetched when opened (a table cell)
  onMove: (to: string) => Promise<void>;
  rowTitle: string;
  suffix?: string | null; // a role view's hint, after the name ("Approved · Oct 3")
  large?: boolean;
}) {
  const [list, setList] = useState<Move[] | null>(moves ?? null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Move | null>(null);
  const pillClass = large ? "h-[24px] rounded-[6px] px-2 text-[13.5px] font-medium" : undefined;
  if (!step) return null;
  const label = [step.name, suffix].filter(Boolean).join(" · ");
  const known = moves ?? list;
  if (moves && !moves.length) return <Pill tone={stepTone(step)} className={pillClass}>{label}</Pill>;

  const at = steps.findIndex((s) => s.id === step.id);
  const stepOf = (id: string) => steps.find((s) => s.id === id);
  const ends = (id: string) => !!stepOf(id)?.end;
  const back = (id: string) => !ends(id) && steps.findIndex((s) => s.id === id) < at;
  const rank = (id: string) => (ends(id) ? 1 : back(id) ? 2 : 0);
  const sorted = [...(known ?? [])].sort((a, b) => rank(a.id) - rank(b.id));

  const go = async (m: Move) => {
    setBusy(true);
    await onMove(m.id);
    setBusy(false);
    setConfirm(null);
  };

  return (
    <>
      <DropdownMenu onOpenChange={(open) => open && !known && loadMoves && void loadMoves().then(setList)}>
        <DropdownMenuTrigger asChild>
          <button type="button" data-step-menu disabled={busy} onClick={(e) => e.stopPropagation()} className="inline-flex cursor-pointer rounded-[6px] outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-default">
            <Pill tone={stepTone(step)} className={cn(pillClass, "gap-1 pr-1")}>
              {label}
              <ChevronDown size={13} strokeWidth={2.2} aria-hidden className="opacity-70" />
            </Pill>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" collisionPadding={8} onClick={(e) => e.stopPropagation()} className="min-w-[220px] rounded-[8px] border-line p-1">
          {!known ? <div className="px-2.5 py-2 text-[14.5px] text-muted">Loading…</div> : null}
          {known && !known.length ? <div className="px-2.5 py-2 text-[14.5px] text-muted">You can&apos;t move it from here.</div> : null}
          {sorted.map((m, i) => {
            const s = stepOf(m.id);
            const prev = sorted[i - 1];
            return (
              <div key={m.id}>
                {prev && rank(prev.id) !== rank(m.id) ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem className="h-9 gap-2 rounded-[6px] px-2.5 text-[14.5px] text-ink" onSelect={() => (ends(m.id) ? setConfirm(m) : void go(m))}>
                  {back(m.id) ? (
                    <span className="text-nav">Back to {m.name}</span>
                  ) : (
                    <>
                      <Pill tone={stepTone(s)}>{m.name}</Pill>
                      {ends(m.id) ? <span className="ml-auto text-[13px] text-muted">Ends it</span> : null}
                    </>
                  )}
                </DropdownMenuItem>
              </div>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {confirm ? (
        <Dialog.Root open onOpenChange={(o) => !o && setConfirm(null)}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-[rgba(15,23,43,.32)]" />
            <Dialog.Content onClick={(e) => e.stopPropagation()} className="fixed top-1/2 left-1/2 z-50 flex w-[420px] -translate-x-1/2 -translate-y-1/2 flex-col gap-3.5 rounded-[12px] bg-white p-5 shadow-[0_24px_48px_rgba(15,23,43,.2)] outline-none">
              <Dialog.Title className="m-0 text-base font-semibold">
                Move {rowTitle} to {confirm.name}?
              </Dialog.Title>
              <Dialog.Description className="m-0 text-[15px] leading-[1.55] text-nav">This ends it, and it can&apos;t be moved on.</Dialog.Description>
              <div className="flex justify-end gap-2">
                <Button onClick={() => setConfirm(null)}>Cancel</Button>
                <Button kind="primary" disabled={busy} onClick={() => void go(confirm)}>
                  Move to {confirm.name}
                </Button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </>
  );
}
