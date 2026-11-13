// The frame's faint blue (decided Nov 5, sample C; docs/plan.md §5b small thing 6). The sidebar fades down, the top bar
// fades from blue at the top to white at its line, and the sidebar's top block matches the top bar so the band across
// the top reads as one. The table, panels and page stay white. The active sidebar row is #EAEFF7, not the sample's
// #E6EBF2: on that, amber, pink and People's orange are under 3:1 (lib/system-colors.test.ts checks every icon).
export const SIDEBAR_BG = "bg-[linear-gradient(180deg,#F7FAFF_0%,#EEF4FC_100%)]";
export const TOP_BAR_BG = "bg-[linear-gradient(180deg,#EFF6FF_0%,#FFFFFF_100%)]";
export const SIDEBAR_ACTIVE = "bg-[#EAEFF7]";
export const SIDEBAR_HOVER = "hover:bg-[#EAEFF7]";
export const SIDEBAR_GROUNDS = ["#F7FAFF", "#EEF4FC", "#EAEFF7"] as const;
