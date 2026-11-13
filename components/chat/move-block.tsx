import { Info, TriangleAlert } from "lucide-react";
import type { MoveView } from "@/server/chat/move-view";
import { Rich, ReplyTable } from "./parts";

// A data move in a reply (M27, m27-a to m27-c): the callout, a few rows as examples or every row that can't be
// mapped, and what to do next. The words and counts come from the kernel (move-view.ts).

export function MoveBlock({ move }: { move: MoveView }) {
  return (
    <>
      <div className={`flex gap-2.5 rounded-[10px] border px-3.5 py-3 text-[15.5px] leading-[1.55] ${move.ok ? "border-[#BFDBFE] bg-[#EFF6FF]" : "border-[#FDE68A] bg-[#FFFBEB]"}`}>
        <span className={`inline-flex pt-[3px] ${move.ok ? "text-ptext" : "text-[#B45309]"}`}>{move.ok ? <Info size={16} strokeWidth={1.8} /> : <TriangleAlert size={16} strokeWidth={1.8} />}</span>
        <span>
          <Rich text={move.lead} />
        </span>
      </div>
      <ReplyTable
        head={move.head}
        widths={move.head.length === 3 ? ["170px", "170px"] : undefined}
        rows={[...move.rows, ...(move.more ? [[<span key="more" className="text-muted">{move.more}</span>]] : [])]}
      />
      {move.after ? <span>{move.after}</span> : null}
    </>
  );
}
