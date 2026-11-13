// Each capability's icon colour (0.4, M23; docs/plan.md §8c-2). A capability keeps the one it got when it was created.
// In this order: a new capability takes the one after the most recently added. The approved set, with sky, green,
// amber and teal a shade darker so every icon passes 3:1 on white, the frame's greys and the active sidebar row
// (checked in lib/cap-colors.test.ts).
export const CAP_COLORS = {
  violet: "#6D4AFF",
  sky: "#0284C7",
  green: "#059669",
  amber: "#C27803",
  pink: "#EC4899",
  teal: "#0D9488",
  red: "#EF4444",
} as const;

export type CapColor = keyof typeof CAP_COLORS;
export const CAP_COLOR_ORDER = Object.keys(CAP_COLORS) as CapColor[];

// A stored name as its colour; anything unknown draws in the text colour.
export const capColor = (name: string | null | undefined): string | undefined => (name && name in CAP_COLORS ? CAP_COLORS[name as CapColor] : undefined);

// The colour after the given one (the most recently added capability's), violet for the first.
export const nextCapColor = (last: string | null | undefined): CapColor => {
  const at = CAP_COLOR_ORDER.indexOf(last as CapColor);
  return CAP_COLOR_ORDER[(at + 1) % CAP_COLOR_ORDER.length]!;
};
