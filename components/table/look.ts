import type { Column } from "@/server/kernel/schema/file";

// The shared table's small decisions (T1, docs/plan.md §8e), kept apart so they can be tested.

const NUMERIC = new Set(["number", "money", "money_range", "percent"]);

// Numbers and money sit at the right, so they line up with each other and with the Sum under them.
export const numeric = (c: Pick<Column, "type" | "result">) => NUMERIC.has(c.type) || (c.type === "computed" && NUMERIC.has(c.result ?? ""));

// A row's first column gets an initials tile only when it holds a name (plain text), not a date or an amount.
export const hasTile = (c: Pick<Column, "type">) => c.type === "text";

export const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

// Soft background and its text colour, as in the approved sample.
export const TILES: readonly (readonly [string, string])[] = [
  ["#CCFBF1", "#0F766E"],
  ["#EDE9FE", "#6D28D9"],
  ["#DBEAFE", "#1D4ED8"],
  ["#FCE7F3", "#BE185D"],
  ["#FEF3C7", "#B45309"],
  ["#DCFCE7", "#15803D"],
];

// The same row always gets the same tile, whatever order the table is in.
export function tileOf(id: string): readonly [string, string] {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TILES[h % TILES.length]!;
}
