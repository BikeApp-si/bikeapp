// Design tokens from the brief (its colours on shadcn). The same values live in app/globals.css.
export const tokens = {
  primary: "#1E90FF",
  primaryHover: "#1673D1",
  primaryDeep: "#0F5CA8",
  primaryLight: "#EFF7FF",
  primaryBorder: "#BBDDFF",
  primaryText: "#1673D1",
  focusRing: "#DCEEFF",
  text: "#0F172B",
  navText: "#314158",
  muted: "#62748E",
  icon: "#45556C",
  border: "#E3E6EA",
  fill: "#F1F5F9",
  page: "#F8FAFC",
  activeNav: "#EEF2F7",
  danger: "#DC2626",
  success: "#18794E",
} as const;

export const layout = { sidebarWidth: 236, panelRadius: 12, panelInset: 8 } as const;
