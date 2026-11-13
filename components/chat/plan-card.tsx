"use client";

import { DynamicIcon, type IconName } from "lucide-react/dynamic";
import { cn } from "@/lib/utils";
import type { PlanView } from "@/server/chat/view";

// The plan as a card in the chat (5c, 5d, 5e, 5g, 5h, 5j). It opens the plan in the side panel.

export function PlanIcon({ name, size }: { name: string; size: number }) {
  return <DynamicIcon name={name as IconName} size={size} strokeWidth={2} fallback={() => <DynamicIcon name="layout-grid" size={size} strokeWidth={2} />} />;
}

const title = (p: PlanView) => (p.latest > 1 ? `${p.name} · v${p.version}` : p.name);

export function PlanCard({ plan, open, button = "Preview", onOpen }: { plan: PlanView; open: boolean; button?: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex max-w-[540px] cursor-pointer items-center gap-3 rounded-[12px] border px-3.5 py-3 text-left shadow-[0_1px_2px_rgba(0,0,0,.05)] outline-none focus-visible:ring-3 focus-visible:ring-focus",
        open ? "border-primary-border bg-primary-light" : "border-line bg-white",
      )}
    >
      <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-[8px] border border-line bg-white text-ink">
        <PlanIcon name={plan.icon} size={20} />
      </span>
      <span className="flex flex-1 flex-col leading-[1.4]">
        <span className="text-base font-semibold">{title(plan)}</span>
        <span className="text-sm text-muted">Plan · New app · {plan.summary}</span>
      </span>
      {open ? (
        <span className="text-[13.5px] font-medium text-primary-text">{button}</span>
      ) : (
        <span className="inline-flex h-[30px] items-center rounded-[8px] border border-line bg-white px-3 text-[15px] text-icon shadow-[0_1px_2px_rgba(0,0,0,.05)]">{button}</span>
      )}
    </button>
  );
}

// 5e: a version that a reply replaced.
export function ReplacedCard({ plan }: { plan: PlanView }) {
  return (
    <div className="flex max-w-[490px] items-center gap-3 rounded-[12px] border border-line bg-page px-3.5 py-3 text-muted">
      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-[8px] border border-line bg-white">
        <PlanIcon name={plan.icon} size={16} />
      </span>
      <span className="flex flex-1 flex-col leading-[1.4]">
        <span className="text-[15.5px] font-medium line-through decoration-[#CAD5E2]">
          {plan.name} · v{plan.version}
        </span>
        <span className="text-[13.5px]">Plan · New app · {plan.summary}</span>
      </span>
      <span className="text-[13.5px]">Replaced by v{plan.latest}</span>
    </div>
  );
}

// 5h: the plan, once Create has started, as one line.
export function CompactCard({ plan }: { plan: PlanView }) {
  return (
    <div className="flex items-center gap-2 rounded-[12px] border border-line px-3.5 py-2.5 text-[15px] text-muted">
      <span className="inline-flex size-[18px] shrink-0 items-center justify-center">
        <PlanIcon name={plan.icon} size={16} />
      </span>
      {plan.name} · {plan.summary}
    </div>
  );
}
