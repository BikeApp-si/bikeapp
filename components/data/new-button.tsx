"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/buttons";

// The Data tab's add button, in the top bar beside Data | Customize (T1). It asks the Data tab below to open its form,
// as the sidebar's Search asks ⌘K to open.
export const NEW_ROW = "bike:new-row";

export function NewButton({ label }: { label: string }) {
  return (
    <Button kind="primary" small className="h-8 px-3" onClick={() => window.dispatchEvent(new Event(NEW_ROW))}>
      <Plus size={14} strokeWidth={2} />
      {label}
    </Button>
  );
}
