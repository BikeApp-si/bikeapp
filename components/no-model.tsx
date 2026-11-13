"use client";

import { createContext, useContext } from "react";
import Link from "next/link";
import { NO_MODEL } from "@/lib/messages";
import { cn } from "@/lib/utils";

// Whether this Bike has an AI model (O3), set once by the signed-in frame; what needs one says so plainly in its
// place (docs/design/o3/). The gateway refuses too: this only decides what is drawn.
const ModelContext = createContext<{ none: boolean; admin: boolean }>({ none: false, admin: false });

export function ModelProvider({ none, admin, children }: { none: boolean; admin: boolean; children: React.ReactNode }) {
  return <ModelContext.Provider value={{ none, admin }}>{children}</ModelContext.Provider>;
}

export const useModel = () => useContext(ModelContext);

export const SettingsAiLink = () => (
  <Link href="/settings/ai" className="text-primary-text underline decoration-primary-border underline-offset-[3px] hover:decoration-primary-text">
    Settings › AI
  </Link>
);

// The note in place of an input that needs a model; admins are told where to add the key.
export function NeedsModel({ line, admin, className, after }: { line: string; admin: boolean; className?: string; after?: React.ReactNode }) {
  return (
    <div className={cn("rounded-[8px] border border-line bg-page px-3.5 py-3 text-[15px] leading-[1.55] text-muted", className)}>
      {line}
      {admin ? (
        <>
          {" "}
          {NO_MODEL.addKey} <SettingsAiLink />
          {after ?? "."}
        </>
      ) : null}
    </div>
  );
}
