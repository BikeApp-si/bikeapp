// Each of Bike's own pages has a fixed icon colour, in line style like a capability's (T1, docs/plan.md §8e).
// Wade's sample colours, each at least 3:1 on white and the active sidebar row (lib/system-colors.test.ts):
// Home takes the links' blue (#1673D1) since the primary #1E90FF is under 3:1 on the active row, Audit log a shade
// darker lime for the same reason. Search and Ontology take hues no capability uses.
export const SYSTEM_COLORS = {
  search: "#C026D3",
  home: "#1673D1",
  inbox: "#E11D48", // M31, rose (decided Nov 7)
  chats: "#6366F1",
  reports: "#7C3AED", // M33, violet (m33-d, approved Nov 8)
  people: "#EA580C",
  audit: "#4D7C0F",
  ontology: "#0891B2",
  settings: "#64748B",
} as const;

export type SystemPage = keyof typeof SYSTEM_COLORS;
