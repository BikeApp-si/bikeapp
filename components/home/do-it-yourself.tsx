"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronRight } from "lucide-react";

export type ActionItem = { label: string; capability: string; href: string; icon: React.ReactNode };

// Up to 6 in two columns, filled down the first column, then the second; "All N actions" shows the rest.
export function DoItYourself({ actions }: { actions: ActionItem[] }) {
  const [all, setAll] = useState(false);
  if (!actions.length) return null;
  const shown = all ? actions : actions.slice(0, 6);
  const half = Math.ceil(shown.length / 2);
  return (
    <div className="mx-auto mt-[18px] flex w-[720px] max-w-full flex-col gap-1.5">
      <div className="flex items-center px-1">
        <span className="flex-1 text-[15px] font-semibold text-nav">Do it yourself</span>
        {actions.length > 6 && !all ? (
          <button type="button" onClick={() => setAll(true)} className="text-[15px] font-medium text-primary-text hover:text-primary-hover">
            All {actions.length} actions
          </button>
        ) : null}
      </div>
      <div className="flex gap-6">
        {[shown.slice(0, half), shown.slice(half)].map((col, i) => (
          <div key={i} className="flex min-w-0 flex-1 flex-col">
            {col.map((a) => (
              <Link key={a.href} href={a.href} className="flex h-11 items-center gap-2.5 border-b border-fill px-1 text-base hover:bg-page">
                <span className="inline-flex text-icon">{a.icon}</span>
                <span className="flex-1 truncate text-ink">{a.label}</span>
                <span className="text-sm text-[#90A1B9]">{a.capability}</span>
                <ChevronRight size={14} strokeWidth={1.8} className="text-[#90A1B9]" />
              </Link>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
