import { describe, expect, it } from "vitest";
import { CAP_COLORS } from "./cap-colors";
import { SIDEBAR_GROUNDS } from "./chrome";
import { SYSTEM_COLORS } from "./system-colors";

// The system pages' icon colours (T1): at least 3:1 on what they sit on, and never one a capability can get.

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("system page colours", () => {
  it.each(Object.entries(SYSTEM_COLORS))("%s is at least 3:1 on white and the active row", (_, hex) => {
    for (const on of ["#FFFFFF", "#F8FAFC", "#EEF2F7"]) expect(contrast(hex, on)).toBeGreaterThanOrEqual(3);
  });

  // The sidebar's faint blue (small thing 6): both ends of its gradient and the active row, for every icon it shows.
  it.each([...Object.entries(SYSTEM_COLORS), ...Object.entries(CAP_COLORS)])("%s is at least 3:1 on the sidebar's blue", (_, hex) => {
    for (const on of SIDEBAR_GROUNDS) expect(contrast(hex, on)).toBeGreaterThanOrEqual(3);
  });

  it("never matches a capability's colour", () => {
    const caps = new Set(Object.values(CAP_COLORS).map((c) => c.toUpperCase()));
    for (const hex of Object.values(SYSTEM_COLORS)) expect(caps.has(hex.toUpperCase())).toBe(false);
  });
});
