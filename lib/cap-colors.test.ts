import { describe, expect, it } from "vitest";
import { CAP_COLOR_ORDER, CAP_COLORS, capColor, nextCapColor } from "./cap-colors";

// The capability colours (0.4, M23): the cycle, and every colour at least 3:1 against what a capability's icon sits
// on (white, the frame's two greys, the active sidebar row), as WCAG asks of icons.

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("capability colours", () => {
  it("cycle in a fixed order, violet first", () => {
    expect(nextCapColor(null)).toBe("violet");
    expect(nextCapColor("violet")).toBe("sky");
    expect(nextCapColor("red")).toBe("violet");
    expect(CAP_COLOR_ORDER).toEqual(["violet", "sky", "green", "amber", "pink", "teal", "red"]);
  });

  it("an unknown name draws in the text colour", () => {
    expect(capColor("violet")).toBe("#6D4AFF");
    expect(capColor("plaid")).toBeUndefined();
  });

  it.each(Object.entries(CAP_COLORS))("%s is at least 3:1 on white, the frame's greys and the active row", (_, hex) => {
    for (const on of ["#FFFFFF", "#F8FAFC", "#F1F5F9", "#EEF2F7"]) expect(contrast(hex, on)).toBeGreaterThanOrEqual(3);
  });
});
