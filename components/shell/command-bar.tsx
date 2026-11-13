"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "radix-ui";
import { CornerDownLeft, FileText, Plus, Search } from "lucide-react";
import { CapIcon } from "@/components/cap-icon";
import { capColor } from "@/lib/cap-colors";
import { cn } from "@/lib/utils";
import { commandsFor, findForCommand } from "@/app/ws/[ws]/(app)/commands";
import type { CommandIndex, FoundRow } from "@/server/kernel/commands";
import { useStartNavigation } from "./navigation";

// ⌘K (0.4, M21): one box to go anywhere the person may go. Rows found by a few letters first, then capabilities and
// their sheets, the rows they add ("New contract"), and the sidebar's pages. Everything listed comes from the kernel
// as this person, so it never names what they couldn't open. ↑/↓ to move, Enter to go, Esc to close.

type Item = { key: string; label: string; detail?: string; href: string; icon: React.ReactNode; group: string };

const ROWS_AFTER_MS = 150;
// The sidebar's Search opens it the same way.
export const OPEN_COMMANDS = "bike:commands";

const matches = (q: string, ...words: (string | undefined)[]) => {
  const t = q.trim().toLowerCase();
  return !t || words.some((w) => w?.toLowerCase().includes(t));
};

export function CommandBar() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [index, setIndex] = useState<CommandIndex | null>(null);
  const [rows, setRows] = useState<FoundRow[]>([]);
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const startNavigation = useStartNavigation();

  // Opened empty, with what the person can reach read fresh (a capability may have been added since).
  const show = useCallback((on: boolean) => {
    setOpen(on);
    if (!on) return;
    setQ("");
    setRows([]);
    setAt(0);
    void commandsFor().then((r) => r.ok && setIndex(r.index));
  }, []);
  const openRef = useRef(open);
  useEffect(() => void (openRef.current = open), [open]);

  // ⌘K or Ctrl+K anywhere in the app; again to close. The sidebar's Search sends OPEN_COMMANDS.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        show(!openRef.current);
      }
    };
    const onOpen = () => show(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_COMMANDS, onOpen);
    return () => (window.removeEventListener("keydown", onKey), window.removeEventListener(OPEN_COMMANDS, onOpen));
  }, [show]);

  // Rows once typing pauses; a later answer never replaces a newer one.
  const asked = useRef(0);
  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) return;
    const n = ++asked.current;
    const t = setTimeout(() => void findForCommand(text).then((r) => n === asked.current && r.ok && setRows(r.rows)), ROWS_AFTER_MS);
    return () => clearTimeout(t);
  }, [q]);

  const items = useMemo<Item[]>(() => {
    if (!index) return [];
    const out: Item[] = (q.trim().length < 2 ? [] : rows).map((r) => ({
      key: `row:${r.id}`,
      label: r.title,
      detail: [r.capability, r.sheet === r.capability ? null : r.sheet, r.step].filter(Boolean).join(" · "),
      href: `/c/${r.capabilityId}?sheet=${r.sheetId}&row=${r.id}`,
      icon: <FileText size={15} strokeWidth={1.8} />,
      group: "Rows",
    }));
    for (const c of index.capabilities) {
      if (matches(q, c.name)) out.push({ key: `cap:${c.id}`, label: c.name, href: `/c/${c.id}`, icon: <CapIcon name={c.icon} size={15} strokeWidth={1.8} color={capColor(c.color)} />, group: "Apps" });
      // Its other sheets, when it has more than one.
      if (c.sheets.length > 1)
        for (const s of c.sheets.slice(1))
          if (q.trim() && matches(q, s.name)) out.push({ key: `sheet:${c.id}:${s.id}`, label: s.name, detail: c.name, href: `/c/${c.id}?sheet=${s.id}`, icon: <CapIcon name={c.icon} size={15} strokeWidth={1.8} color={capColor(c.color)} />, group: "Apps" });
    }
    for (const a of index.actions)
      if (matches(q, a.label, a.capability)) out.push({ key: `new:${a.href}`, label: a.label, detail: a.capability, href: a.href, icon: <CapIcon name={a.icon} size={15} strokeWidth={1.8} color={capColor(a.color)} />, group: "Do it yourself" });
    for (const p of index.pages) if (matches(q, p.label)) out.push({ key: `page:${p.href}`, label: p.label, href: p.href, icon: <CornerDownLeft size={15} strokeWidth={1.8} />, group: "Go to" });
    return out;
  }, [index, rows, q]);

  // The picked line stays on the list as it shrinks.
  const cur = Math.min(at, Math.max(items.length - 1, 0));
  // In braces: the effect must return nothing. Chrome's scrollIntoView now returns a Promise, which React took for a
  // cleanup and called, crashing the page as soon as the mouse moved over the results (#3).
  useEffect(() => {
    list.current?.querySelector(`[data-at="${cur}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cur]);

  const go = useCallback(
    (item: Item | undefined) => {
      if (!item) return;
      setOpen(false);
      startNavigation(item.href);
      router.push(item.href);
    },
    [router, startNavigation],
  );

  return (
    <Dialog.Root open={open} onOpenChange={show}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[rgba(15,23,43,.32)]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[14vh] left-1/2 z-50 flex max-h-[min(560px,72vh)] w-[600px] -translate-x-1/2 flex-col overflow-hidden rounded-[12px] bg-white shadow-[0_24px_48px_rgba(15,23,43,.2)] outline-none"
        >
          <Dialog.Title className="sr-only">Go to</Dialog.Title>
          <label className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-4">
            <Search size={16} strokeWidth={1.8} className="text-muted" />
            <input
              autoFocus
              aria-label="Search Bike"
              role="combobox"
              aria-expanded
              aria-controls="command-list"
              aria-activedescendant={items[cur] ? `command-${cur}` : undefined}
              value={q}
              onChange={(e) => (setQ(e.target.value), setAt(0))}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") (e.preventDefault(), setAt(Math.min(cur + 1, items.length - 1)));
                else if (e.key === "ArrowUp") (e.preventDefault(), setAt(Math.max(cur - 1, 0)));
                else if (e.key === "Enter") (e.preventDefault(), go(items[cur]));
              }}
              placeholder="Go to an app, a row or a page…"
              className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-[#90A1B9]"
            />
            <kbd className="rounded-[4px] border border-line px-1.5 text-[12px] text-muted">esc</kbd>
          </label>
          <div ref={list} id="command-list" role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-2">
            {items.length ? (
              items.map((item, i) => (
                <div key={item.key}>
                  {i === 0 || items[i - 1]!.group !== item.group ? <div className="px-2 pt-2 pb-1 text-[12.5px] font-medium text-muted">{item.group}</div> : null}
                  <div
                    id={`command-${i}`}
                    data-at={i}
                    role="option"
                    aria-selected={i === cur}
                    onMouseMove={() => setAt(i)}
                    onClick={() => go(item)}
                    className={cn("flex h-9 cursor-pointer items-center gap-2.5 rounded-[6px] px-2 text-[15px]", i === cur ? "bg-active-nav" : "")}
                  >
                    <span className="flex shrink-0 text-icon">{item.icon}</span>
                    <span className="truncate text-ink">{item.label}</span>
                    {item.detail ? <span className="truncate text-[14px] text-muted">{item.detail}</span> : null}
                  </div>
                </div>
              ))
            ) : (
              <div className="px-2 py-6 text-center text-[15px] text-muted">{index ? "Nothing found." : "…"}</div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
