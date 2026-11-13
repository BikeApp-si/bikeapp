import { ArrowDown, ArrowUp, Search, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { initials, tileOf } from "./look";

// The one table every page uses (T1, docs/plan.md §8e): full width with no card, 36 px rows, a line under each row and
// a lighter one between columns, a white header that stays put while the page scrolls. Its first column is the 40 px
// check column, so a checkbox's centre is 20 px in (on the top bar's icon); the next column has no left padding, so
// its content starts 40 px in (on the page name). Pages without selection keep the check column empty.
const GRID = cn(
  "w-full border-separate border-spacing-0 text-[15px]",
  "[&_td]:h-9 [&_td]:border-b [&_td]:border-r [&_td]:border-b-line [&_td]:border-r-[#EEF0F3] [&_td]:px-2.5 [&_td]:whitespace-nowrap",
  "[&_th]:h-9 [&_th]:border-b [&_th]:border-r [&_th]:border-b-line [&_th]:border-r-[#EEF0F3] [&_th]:px-2.5 [&_th]:text-left [&_th]:text-[14.5px] [&_th]:font-medium [&_th]:whitespace-nowrap [&_th]:text-muted",
  "[&_thead_th]:sticky [&_thead_th]:top-[var(--table-top,0px)] [&_thead_th]:z-[2] [&_thead_th]:bg-white",
  "[&_tr>:nth-child(2)]:pl-0 [&_tr>:last-child]:border-r-0",
);

export function Grid({ label, children, className }: { label?: string; children: React.ReactNode; className?: string }) {
  return (
    <table aria-label={label} className={cn(GRID, className)}>
      {children}
    </table>
  );
}

// The check column's cells: 40 px, centred, no line on their right.
export const CHECK = "w-10 min-w-10 !border-r-0 !px-0 text-center align-middle";

// A header cell: the column type's grey icon, then its name; the sorted column in ink with its arrow.
export function Head({ icon: Icon, sorted, right, className, style, children }: {
  icon?: LucideIcon | null;
  sorted?: "asc" | "desc" | null;
  right?: boolean;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const Arrow = sorted === "desc" ? ArrowUp : ArrowDown;
  return (
    <th className={cn(sorted && "!text-ink", className)} style={style} aria-sort={sorted ? (sorted === "asc" ? "ascending" : "descending") : undefined}>
      <span className={cn("flex items-center gap-1.5", right && "justify-end")}>
        {Icon ? <Icon size={14} strokeWidth={1.8} className={cn("shrink-0", sorted ? "text-icon" : "text-[#90A1B9]")} /> : null}
        {children}
        {sorted ? <Arrow size={13} strokeWidth={1.8} className="shrink-0 text-muted" /> : null}
      </span>
    </th>
  );
}

// A row's checkbox: shown on the row under the mouse, and on every row once one is selected (always shows: the
// header's). Kept clickable and in the keyboard order while hidden.
export function RowCheck({ checked, mixed, onChange, label, always }: { checked: boolean; mixed?: boolean; onChange: () => void; label: string; always?: boolean }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = !!mixed;
      }}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "mx-auto block size-[15px] cursor-pointer rounded-[4px] border-[#CAD5E2] accent-primary",
        !always && !checked && "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100",
      )}
    />
  );
}

// A row's name with its initials tile, in a soft colour that stays with the row.
export function TitleTile({ id, name, children }: { id: string; name: string; children?: React.ReactNode }) {
  const [bg, fg] = tileOf(id);
  return (
    <span className="inline-flex max-w-full items-center gap-2 font-medium">
      {/* The initials are drawn, not written, so they are never part of the row's text (copied, read or searched). */}
      <span
        aria-hidden
        data-initials={initials(name)}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] text-[11px] font-semibold before:content-[attr(data-initials)]"
        style={{ background: bg, color: fg }}
      />
      <span className="truncate">{children ?? name}</span>
    </span>
  );
}

// The row a table's totals sit in: muted, no line under it.
export const FOOT = "bg-white text-[14.5px] text-muted [&>td]:border-b-0 [&>td]:border-r-0";
// A body row: white, the sidebar's grey on hover; the check column shows its box on hover.
export const ROW = "group/row bg-white hover:bg-page";

// The line above a table (T1): 44 px, controls as quiet words; it stays at the top while the table scrolls, and in
// place when a wide table scrolls sideways. A table under it sets --table-top to 44px so its header pins below it.
export const TOOLBAR = "sticky top-0 left-0 z-[3] flex h-11 shrink-0 items-center gap-0.5 border-b border-line bg-white pr-4 pl-1";
export const UNDER_TOOLBAR = { "--table-top": "44px" } as React.CSSProperties;
// A table with no toolbar above it starts 8 px under the top bar, so its rows sit on the sidebar's 36 px lines too.
export const NO_TOOLBAR = "pt-2";
// A picker on the toolbar, as quiet as its words.
export const QUIET_PICKER = "h-7 w-auto flex-none border-0 bg-transparent px-2 text-[14.5px] text-muted shadow-none hover:bg-active-nav hover:text-ink";

// A search box on the toolbar. lead: the toolbar's first control, so its icon sits on the icon line (20 px in) and
// its words on the content line (40 px in).
export function SearchBox({ label, value, onChange, onKeyDown, inputRef, lead, slash }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  inputRef?: React.Ref<HTMLInputElement>;
  lead?: boolean;
  slash?: boolean; // shows the "/" key that jumps to it
}) {
  return (
    <label
      className={cn(
        "inline-flex h-7 shrink-0 items-center rounded-[6px] px-2 text-[14.5px] text-muted hover:bg-active-nav focus-within:text-ink focus-within:ring-1 focus-within:ring-line focus-within:hover:bg-white",
        lead ? "w-52 gap-3" : "w-28 gap-1.5 focus-within:w-44",
      )}
    >
      <Search size={lead ? 16 : 14} strokeWidth={1.8} className="shrink-0" />
      <input
        ref={inputRef}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search"
        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted"
      />
      {slash && !value ? <kbd className="rounded-[4px] border border-line px-1 text-[12px] leading-4 text-muted">/</kbd> : null}
    </label>
  );
}
