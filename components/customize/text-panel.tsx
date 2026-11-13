"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TextSection } from "@/server/kernel/render-text";
import type { Picture } from "@/server/kernel/render-picture";
import { AccessGrid } from "./picture/access-grid";
import { MarkedLine } from "./picture/marks";
import { StepsFlow } from "./picture/steps-flow";

// The right side of Customize (6b–6l): "How {capability} works" and its version line, then the capability from the
// kernel: pictured (V1: its steps as a flow, who can do what as a grid, a waiting change marked) or as the plain text,
// as the person last chose (kept in this browser). Nothing here can be edited; the admin changes it through the chat.
// highlight: the section a guide answer is about (C2), lit and scrolled into view; nothing else opens.

type Shown = "picture" | "text";
const KEPT = "bike:customize-shows";
const ORDER = ["Steps", "Who can see and do what"];
const rank = (heading: string) => (ORDER.includes(heading) ? ORDER.indexOf(heading) : ORDER.length);

// The choice is kept in this browser; where storage is blocked it lasts until the page reloads.
const listeners = new Set<() => void>();
let remembered: Shown | null = null;
function read(): Shown {
  if (remembered) return remembered;
  try {
    return localStorage.getItem(KEPT) === "text" ? "text" : "picture";
  } catch {
    return "picture";
  }
}
function useShown(): [Shown, (s: Shown) => void] {
  const shown = useSyncExternalStore(
    (changed) => (listeners.add(changed), () => void listeners.delete(changed)),
    read,
    () => "picture" as const,
  );
  const pick = (s: Shown) => {
    remembered = s;
    try {
      localStorage.setItem(KEPT, s);
    } catch {}
    listeners.forEach((l) => l());
  };
  return [shown, pick];
}

export function TextPanel({ name, line, sections, picture, highlight = null }: { name: string; line: string; sections: TextSection[]; picture: Picture; highlight?: string | null }) {
  const lit = useRef<HTMLElement>(null);
  const [shown, pick] = useShown();
  useEffect(() => {
    lit.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [highlight, shown]);
  const many = picture.flows.length > 1;
  const litClass = (heading: string) => cn(heading === highlight && "-mx-3 rounded-[8px] bg-primary-light px-3 pb-2");
  const litRef = (heading: string) => (heading === highlight ? lit : undefined);
  const { added, changed } = picture.marks;
  const text = (s: TextSection) => (
    <section key={s.heading} ref={litRef(s.heading)} aria-current={s.heading === highlight ? "true" : undefined} className={litClass(s.heading)}>
      <div className="pt-3 font-semibold text-ink">{s.heading}</div>
      {s.lines
        // Pictured, a sheet's own "Steps: …" line is its flow.
        .filter((l) => shown === "text" || !(many && l.startsWith("Steps: ")))
        .map((l, i) => (
          <div key={i} className={s.muted ? "text-muted" : undefined}>
            {shown === "picture" ? <MarkedLine line={l} added={added} changed={changed} /> : l}
          </div>
        ))}
    </section>
  );
  return (
    <div className="flex w-[560px] shrink-0 flex-col overflow-hidden border-l border-line bg-white">
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line pr-4 pl-6">
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">How {name} works</span>
        <span className="shrink-0 text-[13.5px] text-muted">{line}</span>
        <div role="radiogroup" aria-label="Show it as" className="flex rounded-[7px] bg-fill p-0.5 text-[13.5px]">
          {(["picture", "text"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={shown === s}
              onClick={() => pick(s)}
              className={cn("cursor-pointer rounded-[5px] px-2.5 py-0.5", shown === s ? "bg-white text-ink shadow-[0_1px_2px_rgba(15,23,43,.08)]" : "text-muted hover:text-ink")}
            >
              {s === "picture" ? "Picture" : "Text"}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-6 pt-1.5 pb-6 text-[15.5px] leading-[1.75] text-nav">
        {shown === "text" ? (
          sections.map(text)
        ) : (
          <>
            {picture.summary ? (
              <p className="m-0 mt-3 flex items-start gap-2 rounded-[8px] border border-line px-3 py-2 text-[14px] leading-[1.5]">
                <Sparkles size={15} strokeWidth={1.8} className="mt-[3px] shrink-0 text-primary-text" />
                <span>
                  This preview adds <Count mark="new" n={picture.summary.added} /> and <Count mark="changed" n={picture.summary.changed} />. Nothing is live until you apply it.
                </span>
              </p>
            ) : null}
            {/* The pictures first (the flow, then the grid), then what stays text. */}
            {[...sections].sort((x, y) => rank(x.heading) - rank(y.heading)).map((s) =>
              s.heading === "Steps" ? (
                <section key={s.heading} ref={litRef(s.heading)} aria-current={s.heading === highlight ? "true" : undefined} className={litClass(s.heading)}>
                  {picture.flows.map((f) => (
                    <StepsFlow key={f.sheet} flow={f} title="Steps" />
                  ))}
                </section>
              ) : s.heading === "Who can see and do what" ? (
                <section key={s.heading} ref={litRef(s.heading)} aria-current={s.heading === highlight ? "true" : undefined} className={litClass(s.heading)}>
                  <AccessGrid grid={picture.grid} />
                </section>
              ) : (
                <div key={s.heading}>
                  {text(s)}
                  {/* With a flow per sheet, each sheet's flow follows its own section. */}
                  {many && s.heading.endsWith(" sheet")
                    ? picture.flows.filter((f) => `${f.sheet} sheet` === s.heading).map((f) => <StepsFlow key={f.sheet} flow={f} title={`${f.sheet} steps`} />)
                    : null}
                </div>
              ),
            )}
          </>
        )}
      </div>
    </div>
  );
}

// "4 new", "1 changed": the counts in the colours they are marked with below.
function Count({ mark, n }: { mark: "new" | "changed"; n: number }) {
  return (
    <span className={cn("inline-flex h-[18px] items-center rounded-[4px] px-1.5 align-[1px] text-[12px] font-semibold whitespace-nowrap", mark === "new" ? "bg-[#DDF6E2] text-[#18794E]" : "bg-[#FEF3C7] text-[#B45309]")}>
      {n} {mark}
    </span>
  );
}
