import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// The quiet segmented control (Data | Customize, Ontology | Company rules, All | Waiting on me): 28 px on a
// grey track, the active one white, no blue. Each segment is a link, so the choice is in the address.

export function Segmented({ items }: { items: { label: ReactNode; href: string; active: boolean }[] }) {
  return (
    <div role="tablist" className="inline-flex shrink-0 gap-0.5 rounded-[8px] bg-fill p-0.5">
      {items.map((it) => (
        <Link
          key={it.href}
          role="tab"
          aria-selected={it.active}
          href={it.href}
          className={cn("inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-[14.5px]", it.active ? "bg-white font-medium text-ink" : "text-muted hover:text-ink")}
        >
          {it.label}
        </Link>
      ))}
    </div>
  );
}
