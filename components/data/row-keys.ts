"use client";

import { useEffect, useRef, useState } from "react";

// Keyboard in a table (0.4, M21): ↑/↓ pick a row, Enter opens it, x selects it, s opens its status menu (then the
// arrows and Enter move it, as a click would), Esc lets go. Nothing happens while typing, while a menu or dialog is
// open, or while the record panel is (it has its own Esc). Rows carry data-row; a status menu's button data-step-menu.

export const ROW_RING = "outline-2 -outline-offset-2 outline-primary";

export function useRowKeys({ ids, enabled, onOpen, onToggle }: { ids: string[]; enabled: boolean; onOpen: (id: string) => void; onToggle?: (id: string) => void }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const latest = useRef({ ids, enabled, onOpen, onToggle, cursor });
  useEffect(() => void (latest.current = { ids, enabled, onOpen, onToggle, cursor }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { ids, enabled, onOpen, onToggle, cursor } = latest.current;
      // Only real keys: the Enter sent below to open a status menu isn't one.
      if (!e.isTrusted || !enabled || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || !ids.length) return;
      const t = e.target as HTMLElement | null;
      // Typing, or a key meant for a menu or dialog (which may already have closed by the time it gets here).
      if (t?.closest("input, textarea, select, [contenteditable='true'], [role='menu'], [role='menuitem'], [role='dialog'], [role='alertdialog']")) return;
      if (document.querySelector("[role='dialog'], [role='menu'], [role='alertdialog'], [role='listbox']")) return;
      const at = cursor ? ids.indexOf(cursor) : -1;
      const pick = (i: number) => {
        const id = ids[Math.max(0, Math.min(ids.length - 1, i))]!;
        setCursor(id);
        document.querySelector(`[data-row="${id}"]`)?.scrollIntoView({ block: "nearest" });
      };
      if (e.key === "ArrowDown") return (e.preventDefault(), pick(at + 1));
      if (e.key === "ArrowUp") return (e.preventDefault(), pick(at < 0 ? 0 : at - 1));
      if (at < 0) return;
      if (e.key === "Enter") return (e.preventDefault(), onOpen(cursor!));
      if (e.key === "Escape") return setCursor(null);
      if (e.key === "x" && onToggle) return (e.preventDefault(), onToggle(cursor!));
      if (e.key === "s") {
        const button = document.querySelector<HTMLElement>(`[data-row="${cursor}"] [data-step-menu]`);
        if (!button) return;
        e.preventDefault();
        // The menu opens from the keyboard the way it does when its button has focus.
        button.focus();
        button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A row that left the table (a filter, a delete) lets go.
  const shown = cursor && ids.includes(cursor) ? cursor : null;
  return { cursor: shown, setCursor };
}
