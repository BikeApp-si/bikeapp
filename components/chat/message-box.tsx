"use client";

import { useRef, type RefObject } from "react";
import { useGrow } from "@/components/grow";
import { cn } from "@/lib/utils";

// A chat message box (0.3): one line at first (or `rows`), growing with the text up to `maxRows`, then scrolling.
// Enter sends; Shift+Enter is a new line.
export function MessageBox({
  value,
  onChange,
  onSend,
  label,
  placeholder,
  rows = 1,
  maxRows = 6,
  className,
  boxRef,
}: {
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  label: string;
  placeholder?: string;
  rows?: number;
  maxRows?: number;
  className?: string;
  boxRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = boxRef ?? own;
  useGrow(ref, value, maxRows);
  return (
    <textarea
      ref={ref}
      aria-label={label}
      rows={rows}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onSend();
        }
      }}
      className={cn("flex-1 resize-none bg-transparent text-base leading-6 text-ink outline-none placeholder:text-muted", className)}
    />
  );
}
