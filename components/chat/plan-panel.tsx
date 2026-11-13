"use client";

import { Download, X } from "lucide-react";
import { useEffect } from "react";
import { IconButton } from "@/components/buttons";
import type { PlanView } from "@/server/chat/view";
import { PlanIcon } from "./plan-card";

// 5d, 5f, 5k: the plan in the side panel, as plain text, before it is created. Esc or × closes it; the
// download is the same text as a file.

function asText(plan: PlanView): string {
  return [plan.name, "", ...plan.sections.flatMap((s) => [s.heading, ...s.lines, ""])].join("\n");
}

function download(plan: PlanView) {
  const url = URL.createObjectURL(new Blob([asText(plan)], { type: "text/plain;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `${plan.name} plan.txt` });
  a.click();
  URL.revokeObjectURL(url);
}

export function PlanPanel({ plan, onClose }: { plan: PlanView; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <>
      <div className="absolute inset-0" onClick={onClose} />
      <aside role="dialog" aria-label={`Plan for ${plan.name}`} className="absolute inset-y-0 right-0 flex w-[600px] flex-col border-l border-line bg-white">
        <div className="flex shrink-0 flex-col border-b border-line">
          <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line pr-3 pl-6">
            <span className="flex-1 text-[15px] text-muted">Plan · New app{plan.latest > 1 ? ` · v${plan.version} of ${plan.latest}` : ""}</span>
            <IconButton aria-label="Download" onClick={() => download(plan)}>
              <Download size={15} strokeWidth={1.8} />
            </IconButton>
            <IconButton aria-label="Close" onClick={onClose}>
              <X size={16} strokeWidth={1.8} />
            </IconButton>
          </div>
          <div className="flex items-center gap-2.5 px-6 py-3.5">
            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-[8px] border border-line bg-white text-ink">
              <PlanIcon name={plan.icon} size={18} />
            </span>
            <span className="flex-1 text-[20px] font-semibold tracking-[-0.01em]">{plan.name}</span>
            <span className="inline-flex h-[22px] items-center rounded-[6px] bg-fill px-2 text-[13.5px] font-medium text-icon">{plan.status === "created" ? "Created" : "Not created yet"}</span>
          </div>
        </div>
        <div className="flex-1 overflow-auto px-5 pb-4">
          <div className="text-[15.5px] leading-[1.75] text-nav">
            {plan.sections.map((s) => (
              <div key={s.heading}>
                <div className="pt-3 font-semibold text-ink">{s.heading}</div>
                {s.lines.map((l, i) => (
                  <div key={i} className={s.muted ? "text-muted" : undefined}>
                    {l}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </aside>
    </>
  );
}
