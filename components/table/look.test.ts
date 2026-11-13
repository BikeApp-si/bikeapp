import { describe, expect, it } from "vitest";
import { COLUMN_TYPES } from "@/server/kernel/schema/file";
import { COLUMN_ICONS } from "@/components/data/question-row";
import { hasTile, initials, numeric, tileOf, TILES } from "./look";

describe("the shared table's look (T1)", () => {
  it("has a header icon for every column type", () => {
    for (const t of COLUMN_TYPES) expect(COLUMN_ICONS[t], t).toBeDefined();
  });

  it("puts numbers and money at the right, and computed ones that give a number", () => {
    expect(numeric({ type: "money" })).toBe(true);
    expect(numeric({ type: "percent" })).toBe(true);
    expect(numeric({ type: "computed", result: "money" })).toBe(true);
    expect(numeric({ type: "computed", result: "date" })).toBe(false);
    expect(numeric({ type: "days" })).toBe(false);
    expect(numeric({ type: "text" })).toBe(false);
  });

  it("gives a tile only to a first column that holds a name", () => {
    expect(hasTile({ type: "text" })).toBe(true);
    for (const t of ["date", "money", "person", "link", "long_text"] as const) expect(hasTile({ type: t })).toBe(false);
  });

  it("writes initials from up to two words", () => {
    expect(initials("Acme Health")).toBe("AH");
    expect(initials("Kova")).toBe("K");
    expect(initials("  harbor  logistics  co ")).toBe("HL");
  });

  it("keeps a row's tile the same every time", () => {
    const id = "7d3c9a52-0b1e-4c8e-9f7a-1a2b3c4d5e6f";
    expect(tileOf(id)).toBe(tileOf(id));
    expect(TILES).toContain(tileOf(id));
  });
});
