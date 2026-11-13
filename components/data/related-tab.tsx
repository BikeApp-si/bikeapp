"use client";

import Link from "next/link";
import { Plus, Type } from "lucide-react";
import { CHECK, Grid, Head, ROW } from "@/components/table/table";
import { numeric } from "@/components/table/look";
import { cn } from "@/lib/utils";
import { COLUMN_ICONS, columnIcon } from "./question-row";
import { Pill, stepTone } from "@/components/chips";
import { useStartNavigation } from "@/components/shell/navigation";
import type { RelatedSheet } from "@/server/kernel/related";
import { TableCell } from "./cell";
import type { Names, Person, Step } from "./types";

// One sheet's rows that point at this row (0.4, M22), as the main table draws rows (L2): each opens in its own sheet;
// "+ Add renewal" starts one with the link already filled in. Only what the kernel let this person see is here.

// In the record panel everything starts 24 px in, so the check column is 24 px there.
const PANEL_CHECK = cn(CHECK, "!w-6 !min-w-6");

export function RelatedTab({ group, rowId, people }: { group: RelatedSheet; rowId: string; people: Map<string, Person> }) {
  const startNavigation = useStartNavigation();
  const steps = (stepId: string | null, name: string | null): Step | undefined => (stepId && name ? ({ id: stepId, name } as Step) : undefined);
  const ctx = { names: group.names as Names, people, steps: [] as Step[] };
  const add = `/c/${group.capabilityId}?sheet=${group.sheetId}&new=1&link=${group.column.id}:${rowId}`;
  const hasStep = group.rows.some((r) => r.step);
  return (
    <div className="-mx-6 flex flex-col">
      {group.rows.length ? (
        <Grid label={group.sheet} className="text-[14.5px] [&_td]:h-10 [&_th]:h-10 [&_tr>:last-child]:pr-6 [&_thead_th]:static">
          <thead>
            <tr>
              <th className={PANEL_CHECK} />
              <Head icon={Type}>{group.titleName}</Head>
              {group.shownColumns.map((c) => (
                <Head key={c.id} icon={columnIcon(c)} right={numeric(c)}>{c.name}</Head>
              ))}
              {hasStep ? <Head icon={COLUMN_ICONS.step}>Status</Head> : null}
            </tr>
          </thead>
          <tbody>
            {group.rows.map((r) => {
              const href = `/c/${group.capabilityId}?sheet=${group.sheetId}&row=${r.id}`;
              return (
                <tr
                  key={r.id}
                  className={cn("cursor-pointer", ROW)}
                  onClick={(e) => {
                    if (!(e.target as HTMLElement).closest("a, button")) e.currentTarget.querySelector("a")?.click();
                  }}
                >
                  <td className={PANEL_CHECK} />
                  <td>
                    <Link href={href} onClick={() => startNavigation(href)} className="font-medium text-ink outline-none focus-visible:underline">
                      {r.title}
                    </Link>
                  </td>
                  {group.shownColumns.map((c) => (
                    <td key={c.id} className={cn("text-muted", numeric(c) && "text-right")}>
                      {r.data[c.id] === null || r.data[c.id] === undefined || r.data[c.id] === "" ? null : <TableCell column={c} value={r.data[c.id]} ctx={ctx} />}
                    </td>
                  ))}
                  {hasStep ? <td>{r.step ? <Pill tone={stepTone(steps(r.stepId, r.step))}>{r.step}</Pill> : null}</td> : null}
                </tr>
              );
            })}
          </tbody>
        </Grid>
      ) : null}
      {group.count > group.rows.length ? <span className="border-b border-line px-6 py-2 text-[14px] text-muted">{group.count - group.rows.length} more</span> : null}
      {group.canAdd ? (
        <Link href={add} onClick={() => startNavigation(add)} className="flex h-10 items-center gap-1.5 border-b border-line px-6 text-[14.5px] text-muted hover:bg-page hover:text-ink">
          <Plus size={14} strokeWidth={1.8} />
          {group.addAction}
        </Link>
      ) : null}
    </div>
  );
}
