import { FileText, Plus } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/buttons";
import type { SheetView } from "@/server/kernel/views";
import { useModel } from "@/components/no-model";

// 5i: a capability with no rows yet. The sheet's columns, then what to do first: import a spreadsheet (Home's
// chat, with the file) or add one by hand.
export function EmptyCapability({ capId, capName, icon, sheet, onAdd }: { capId: string; capName: string; icon: React.ReactNode; sheet: SheetView; onAdd: (() => void) | null }) {
  const n = sheet.columns.length;
  // Importing reads the spreadsheet's columns with the model: with none (O3), only adding by hand is offered.
  const model = useModel();
  return (
    <div className="flex min-h-0 flex-1 flex-col px-8">
      <div className="pb-2.5 text-base">
        <span className="font-semibold">{sheet.name}</span>
        <span className="ml-2.5 text-[15px] text-muted">
          0 rows · {n} {n === 1 ? "column" : "columns"}
        </span>
      </div>
      <div className="overflow-hidden rounded-[8px] border border-line">
        <table className="w-full border-collapse text-[15px]">
          <thead>
            <tr>
              {sheet.columns.map((c) => (
                <th key={c.id} className="h-9 px-2.5 text-left font-medium whitespace-nowrap text-muted">
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
        </table>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 pb-16">
        <span className="inline-flex size-12 items-center justify-center rounded-[10px] border border-line bg-white text-ink">{icon}</span>
        <div className="pt-2 text-lg font-semibold">{capName} is ready</div>
        <div className="text-base text-muted">No {sheet.row.many} yet.</div>
        <div className="flex gap-2 pt-2.5">
          {model.none ? null : <Link
            href={`/home?import=${capId}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-[6px] border border-line bg-white px-3.5 text-[15px] font-medium shadow-[0_1px_2px_rgba(0,0,0,.05)] hover:bg-page"
          >
            <FileText size={14} strokeWidth={1.8} />
            Import a spreadsheet
          </Link>}
          {onAdd ? (
            <Button onClick={onAdd}>
              <Plus size={14} strokeWidth={1.8} />
              Add one by hand
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
