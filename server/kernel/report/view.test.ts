import { describe, expect, it } from "vitest";
import type { Formats } from "@/lib/format";
import { formatCell, periodOf, when } from "./view";
import type { ReportQuery } from "./schema";

// A report's values as the company writes them (M26): dollars as before for Fernwood; rupees in Indian grouping
// and day-first dates for a company in India.
const INDIA: Formats = { currency: "INR", grouping: "indian", dates: "dmy", yearStart: 4 };
const between = (from: string, to: unknown) => ({ where: { op: "between", args: [{ col: "date" }, from, to] } }) as unknown as ReportQuery;
const RAN = new Date("2026-10-26T15:02:00Z");
const TZ = "America/Chicago";

describe("report view", () => {
  it("writes cells in dollars by default and in rupees for a company in India", () => {
    const years = new Set<string>();
    expect(formatCell(1_234_567, "money", years)).toBe("$1,234,567");
    expect(formatCell(1_234_567, "money", years, INDIA)).toBe("₹12,34,567");
    expect(formatCell(1_234_567, "number", years, INDIA)).toBe("12,34,567");
    expect(formatCell("2026-10-05", "date", years)).toBe("Oct 5");
    expect(formatCell("2026-10-05", "date", years, INDIA)).toBe("5 Oct");
  });

  it("names the period and the run's time the company's way", () => {
    expect(periodOf(between("2026-10-01", { ref: "today" }), RAN, TZ)).toBe("Oct 1–26, 2026");
    expect(periodOf(between("2026-07-01", { ref: "today" }), RAN, TZ)).toBe("Jul 1–Oct 26, 2026");
    expect(periodOf(between("2026-10-01", { ref: "today" }), RAN, TZ, INDIA)).toBe("1–26 Oct 2026");
    expect(periodOf(between("2026-04-01", { ref: "today" }), RAN, TZ, INDIA)).toBe("1 Apr–26 Oct 2026");
    expect(periodOf(between("2025-04-01", "2026-03-31"), RAN, TZ, INDIA)).toBe("1 Apr 2025–31 Mar 2026");
    expect(when(RAN, TZ)).toBe("Oct 26, 10:02");
    expect(when(RAN, TZ, true)).toBe("Oct 26, 2026, 10:02");
    expect(when(RAN, TZ, true, INDIA)).toBe("26 Oct 2026, 10:02");
  });
});
