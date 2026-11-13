"use client";

import { Avatar } from "@/components/chips";
import { cn } from "@/lib/utils";
import { orgChart, type OrgNode } from "@/server/kernel/org-chart";
import type { PersonRow } from "@/server/kernel/directory";

// People › Org chart (0.5, M28, m28-c), read only: each person at the top, the people who report to them in a row
// under them, and everyone further down stacked under their manager. A click opens the person, as in the table.

type P = PersonRow & { tint: string };
const LINE = "bg-[#CAD5E2]";

function Card({ person, open, onOpen, className }: { person: P; open: boolean; onOpen: (id: string) => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(person.id)}
      className={cn(
        "flex h-14 w-full cursor-pointer items-center gap-2.5 rounded-[8px] border border-line bg-white px-3 text-left outline-none hover:bg-page focus-visible:ring-3 focus-visible:ring-focus",
        open && "!bg-primary-light",
        className,
      )}
    >
      <Avatar name={person.name} tint={person.tint} size={28} className="text-[12.5px]" />
      <span className="min-w-0">
        <span className="block truncate text-[15px] font-medium text-ink">{person.name}</span>
        {person.title ? <span className="block truncate text-[13.5px] text-muted">{person.title}</span> : null}
      </span>
    </button>
  );
}

// The people under someone, stacked, on a line down from them.
function Stack({ nodes, open, onOpen }: { nodes: OrgNode<P>[]; open: string | null; onOpen: (id: string) => void }) {
  return (
    <ul className="ml-6">
      {nodes.map((n, i) => (
        <li key={n.person.id} className="relative pt-2 pl-5">
          <span aria-hidden className={cn("absolute top-0 left-0 w-px", LINE, i === nodes.length - 1 ? "h-9" : "h-full")} />
          <span aria-hidden className={cn("absolute top-9 left-0 h-px w-5", LINE)} />
          <Card person={n.person} open={open === n.person.id} onOpen={onOpen} />
          {n.reports.length ? <Stack nodes={n.reports} open={open} onOpen={onOpen} /> : null}
        </li>
      ))}
    </ul>
  );
}

// Someone at the top, with the people who report to them side by side under a line.
function Top({ node, open, onOpen }: { node: OrgNode<P>; open: string | null; onOpen: (id: string) => void }) {
  const many = node.reports.length;
  return (
    <div className="flex flex-col items-center">
      <div className="w-[260px]">
        <Card person={node.person} open={open === node.person.id} onOpen={onOpen} />
      </div>
      {many ? (
        <>
          <span aria-hidden className={cn("h-7 w-px", LINE)} />
          <ul className="flex">
            {node.reports.map((r, i) => (
              <li key={r.person.id} className="relative w-[308px] px-6 pt-7">
                {many > 1 ? <span aria-hidden className={cn("absolute top-0 h-px", LINE, i === 0 ? "right-0 left-1/2" : i === many - 1 ? "right-1/2 left-0" : "inset-x-0")} /> : null}
                <span aria-hidden className={cn("absolute top-0 left-1/2 h-7 w-px", LINE)} />
                <Card person={r.person} open={open === r.person.id} onOpen={onOpen} />
                {r.reports.length ? <Stack nodes={r.reports} open={open} onOpen={onOpen} /> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

export function OrgChart({ people, open, onOpen }: { people: P[]; open: string | null; onOpen: (id: string) => void }) {
  const { tops, noManager } = orgChart(people);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-auto px-6 pt-10 pb-10" aria-label="Org chart">
      <div className="flex flex-col items-center gap-10">
        {tops.map((n) => (
          <Top key={n.person.id} node={n} open={open} onOpen={onOpen} />
        ))}
      </div>
      {noManager.length ? (
        <section aria-label="No manager" className="mt-12 w-full max-w-[924px] border-t border-line px-6 pt-5">
          <h2 className="m-0 mb-3 text-[15px] font-normal text-muted">No manager</h2>
          <div className="grid grid-cols-3 gap-x-12 gap-y-3">
            {noManager.map((p) => (
              <Card key={p.id} person={p} open={open === p.id} onOpen={onOpen} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
