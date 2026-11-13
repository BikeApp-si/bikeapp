"use client";

import { OUTLINED } from "@/components/buttons";
import { Check, History } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Popover } from "radix-ui";
import { cn } from "@/lib/utils";

// Versions on the Ontology (m34-b): every kept version, newest first, with when it was written and what after.
// The one on the page is ticked; the newest opens the page as it is, an older one read only (m34-c).

export type VersionRow = { version: number; when: string; what: string };

export const outlined = OUTLINED;

export function OntologyVersions({ versions, showing }: { versions: VersionRow[]; showing: number | null }) {
  const [open, setOpen] = useState(false);
  const newest = versions[0]?.version;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={outlined}>
        <History size={16} strokeWidth={2} />
        Versions
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="z-50 w-[430px] rounded-[10px] border border-line bg-white p-1.5 shadow-[0_8px_24px_rgba(15,23,43,.12)]">
          <nav aria-label="Versions" className="flex max-h-[420px] flex-col overflow-auto">
            {versions.map((v) => {
              const on = v.version === showing;
              return (
                <Link
                  key={v.version}
                  href={v.version === newest ? "/ontology" : `/ontology?version=${v.version}`}
                  aria-current={on ? "page" : undefined}
                  onClick={() => setOpen(false)}
                  className={cn("flex gap-2.5 rounded-[8px] px-3 py-2.5 hover:bg-page", on && "bg-[#F1F5F9] hover:bg-[#F1F5F9]")}
                >
                  <span className="w-4 shrink-0 pt-0.5 text-primary">{on ? <Check size={15} strokeWidth={2.2} /> : null}</span>
                  <span className="flex flex-1 flex-col gap-0.5">
                    <span className="text-[15px] font-medium text-ink">
                      Version {v.version}
                      <span className="font-normal text-muted"> · {v.when}</span>
                    </span>
                    <span className="text-sm leading-[1.45] text-muted">
                      {v.version === newest ? "Current. " : ""}
                      {v.what}
                    </span>
                  </span>
                </Link>
              );
            })}
          </nav>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
