import { describe, expect, it } from "vitest";
import { dailyHeading, partOfDay } from "./greeting";

describe("greeting", () => {
  it("picks one heading a day per person, the same all day", () => {
    const a = dailyHeading("p1", "2026-10-27", "Wade", "Fernwood");
    expect(dailyHeading("p1", "2026-10-27", "Wade", "Fernwood")).toBe(a);
    const week = new Set(["21", "22", "23", "24", "25", "26", "27"].map((d) => dailyHeading("p1", `2026-10-${d}`, "Wade", "Fernwood")));
    expect(week.size).toBeGreaterThan(1);
    for (const h of week) {
      expect(h.length).toBeLessThan(45);
      expect(h).not.toMatch(/[{}]/);
    }
  });

  it("says good afternoon in the workspace's time zone", () => {
    expect(partOfDay(new Date("2026-10-27T19:00:00Z"), "America/Chicago")).toBe("afternoon");
  });
});
