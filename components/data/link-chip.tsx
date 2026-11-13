"use client";

import { useState } from "react";
import Link from "next/link";
import { HoverCard } from "radix-ui";
import { Link2 } from "lucide-react";
import { Pill, stepTone } from "@/components/chips";
import { rowPreview } from "@/app/ws/[ws]/(app)/c/[cap]/actions";
import type { Step } from "./types";

// A linked row as a chip (0.3, M18). Hovering or focusing it shows a small card after a short pause: the row's title,
// its step and a few of its answers, read as the person through the kernel, and Open. A row they can't see shows no
// card.

type Preview = { id: string; capId: string; sheetId: string; capName: string; title: string; step: Step | null; fields: { name: string; text: string }[] };

export function LinkChip({ id, name }: { id: string; name: string }) {
  const [card, setCard] = useState<Preview | null | "none">(null);
  const load = (open: boolean) => {
    if (!open || card) return;
    void rowPreview(id).then((r) => setCard(r.ok ? r : "none"));
  };
  return (
    <HoverCard.Root openDelay={350} closeDelay={100} onOpenChange={load}>
      <HoverCard.Trigger asChild>
        <a
          href="#"
          onClick={(e) => (e.preventDefault(), e.stopPropagation())}
          className="inline-flex h-5 max-w-[220px] items-center gap-1 truncate rounded-[4px] bg-fill px-1.5 text-ink outline-none hover:bg-line focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Link2 size={12} strokeWidth={1.8} className="shrink-0 text-icon" aria-hidden />
          <span className="truncate">{name}</span>
        </a>
      </HoverCard.Trigger>
      {card === "none" ? null : (
        <HoverCard.Portal>
          <HoverCard.Content
            side="bottom"
            align="start"
            sideOffset={6}
            onClick={(e) => e.stopPropagation()}
            className="z-50 flex w-72 flex-col gap-2 rounded-[10px] border border-line bg-white p-3.5 text-[14.5px] shadow-[0_12px_32px_rgba(15,23,43,.14)]"
          >
            {!card ? (
              <span className="text-muted">Loading…</span>
            ) : (
              <>
                <span className="text-[12.5px] text-muted">{card.capName}</span>
                <span className="flex items-center gap-2">
                  <span className="flex-1 truncate text-[15.5px] font-semibold text-ink">{card.title}</span>
                  {card.step ? <Pill tone={stepTone(card.step)}>{card.step.name}</Pill> : null}
                </span>
                {card.fields.length ? (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                    {card.fields.map((f) => (
                      <div key={f.name} className="contents">
                        <dt className="text-muted">{f.name}</dt>
                        <dd className="truncate text-ink">{f.text}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                <Link href={`/c/${card.capId}?sheet=${card.sheetId}&row=${card.id}`} className="self-start text-[14px] font-medium text-primary-text hover:text-primary-hover">
                  Open
                </Link>
              </>
            )}
          </HoverCard.Content>
        </HoverCard.Portal>
      )}
    </HoverCard.Root>
  );
}
