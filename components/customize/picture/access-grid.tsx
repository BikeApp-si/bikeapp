import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Cell, Grid } from "@/server/kernel/render-picture";
import { MarkTag } from "./marks";

// Who can see and do what as a grid (V1): a row per role with who is in it; Sees, Adds, Edits, Moves, Changes it.
// The plain sentences below.

const chip = "rounded-[4px] px-1.5 py-px text-[12.5px] whitespace-nowrap";

function CellView({ cell }: { cell: Cell }) {
  const inner =
    cell.kind === "yes" ? <Check size={16} strokeWidth={1.8} aria-label="Yes" className="mx-auto text-[#18794E]" />
    : cell.kind === "no" ? <Minus size={16} strokeWidth={1.8} aria-label="No" className="mx-auto text-[#CAD5E2]" />
    : cell.kind === "every" ? <span className={cn(chip, "bg-fill text-nav")}>every</span>
    : cell.kind === "from" ? <span className={cn(chip, "bg-[#EDE9FE] text-[#6D28D9]")}>from {cell.steps!.join(", ")}</span>
    : <span className={cn(chip, "bg-primary-light text-primary-text")}>{cell.kind}</span>;
  return <td className={cn("h-11 border-b border-line px-1.5 text-center", cell.mark && "bg-[#FFFBEB] shadow-[inset_0_0_0_1.5px_#FCD34D]")}>{inner}</td>;
}

export function AccessGrid({ grid }: { grid: Grid }) {
  return (
    <section aria-label="Who can see and do what">
      <h3 className="m-0 pt-3 pb-2.5 text-[15px] font-semibold text-ink">Who can see and do what</h3>
      <div className="overflow-hidden rounded-[8px] border border-line">
        <table className="w-full border-collapse text-[14px] [&_tr:last-child>td]:border-b-0">
          <thead>
            <tr className="text-[12.5px] text-muted">
              <th className="w-[40%] border-b border-line" />
              {["Sees", "Adds", "Edits", "Moves", "Changes it"].map((h) => (
                <th key={h} className="h-9 border-b border-line px-1.5 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((r, i) => (
              <tr key={i} className={cn(r.mark === "new" && "bg-[#F6FDF8]")}>
                <td className="border-b border-line py-1.5 pr-2 pl-3 text-left">
                  <span className="flex items-center gap-1.5 font-medium text-ink">
                    {r.role}
                    {r.on ? <span className="font-normal text-muted">· on {r.on}</span> : null}
                    {r.mark ? <MarkTag mark={r.mark} /> : null}
                  </span>
                  {r.who ? (
                    <span className="block text-[12.5px] leading-[1.6] text-muted">
                      {r.who.split(", ").map((n, j) => (
                        <span key={n} className="whitespace-nowrap">
                          {j ? ", " : ""}
                          {n}
                          {r.newMembers.includes(n) ? (
                            <>
                              {" "}
                              <MarkTag mark="new" />
                            </>
                          ) : null}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </td>
                <CellView cell={r.sees} />
                <CellView cell={r.adds} />
                <CellView cell={r.edits} />
                <CellView cell={r.moves} />
                <CellView cell={r.changes} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2.5 flex flex-col gap-1 text-[13.5px] leading-[1.5] text-muted">
        {grid.caption.map((l) => (
          <p key={l} className="m-0">{l}</p>
        ))}
      </div>
    </section>
  );
}
