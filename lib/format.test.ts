import { describe, expect, it } from "vitest";
import { currencySign, dayRange, displayValue, formatDate, formatDay, formatMoney, formatNumber, formatsOf, formatUtc, relativeDay, tenure, type Formats } from "./format";

const INDIA: Formats = { currency: "INR", grouping: "indian", dates: "dmy", yearStart: 4 };

describe("format", () => {
  it("money, dates and times", () => {
    expect(formatMoney(3_840_000)).toBe("$38,400");
    expect(formatMoney(8_250)).toBe("$82.50");
    expect(formatDate("2026-11-14")).toBe("Nov 14, 2026");
    expect(formatDay("2026-10-15")).toBe("Oct 15");
    expect(formatUtc(new Date("2026-10-22T14:52:08.123Z"))).toBe("2026-10-22 14:52:08");
  });

  it("days from today", () => {
    expect(relativeDay("2026-11-14", "2026-10-20")).toBe("in 25 days");
    expect(relativeDay("2026-10-21", "2026-10-20")).toBe("tomorrow");
    expect(relativeDay("2026-10-20", "2026-10-20")).toBe("today");
    expect(relativeDay("2026-10-17", "2026-10-20")).toBe("3 days ago");
  });

  it("tenure", () => {
    expect(tenure("2024-06-10", "2026-10-27")).toBe("2 years, 4 months");
    expect(tenure("2024-06-10", "2026-06-09")).toBe("1 year, 11 months");
    expect(tenure("2026-06-10", "2026-06-20")).toBe("10 days");
    expect(tenure("2026-11-02", "2026-10-27")).toBe("starts in 6 days");
  });

  it("each column type as text", () => {
    const names = { person: (id: string) => ({ k: "Krishna" })[id], row: () => "Northwind", file: () => "Northwind-MSA-2025.pdf", step: () => "Active" };
    expect(displayValue({ type: "money" }, 3_840_000)).toBe("$38,400");
    expect(displayValue({ type: "money_range" }, { from: 9_000_000, to: 12_000_000 })).toBe("$90,000 – $120,000");
    expect(displayValue({ type: "days" }, 30)).toBe("30 days");
    expect(displayValue({ type: "days" }, 1)).toBe("1 day");
    expect(displayValue({ type: "date" }, "2026-11-14")).toBe("Nov 14, 2026");
    expect(displayValue({ type: "computed", result: "date" }, "2026-10-15")).toBe("Oct 15, 2026");
    expect(displayValue({ type: "choice", options: [{ id: "a", name: "Vacation" }] }, "a")).toBe("Vacation");
    expect(displayValue({ type: "person" }, "k", names)).toBe("Krishna");
    expect(displayValue({ type: "link" }, "x", names)).toBe("Northwind");
    expect(displayValue({ type: "file" }, "x", names)).toBe("Northwind-MSA-2025.pdf");
    expect(displayValue({ type: "step" }, "active", names)).toBe("Active");
    expect(displayValue({ type: "text" }, null)).toBe("");
    expect(displayValue({ type: "percent" }, 12.5)).toBe("12.5%");
  });

  it("writes two dates as one range", () => {
    expect(dayRange("2026-12-28", "2026-12-31")).toBe("Dec 28–31");
    expect(dayRange("2026-09-30", "2026-10-02")).toBe("Sep 30 – Oct 2");
    expect(dayRange("2026-06-02", "2026-06-02")).toBe("Jun 2");
  });

  it("a company's own money, numbers and dates (M26)", () => {
    expect(formatMoney(123_456_700, INDIA)).toBe("₹12,34,567");
    expect(formatMoney(8_250, INDIA)).toBe("₹82.50");
    expect(formatNumber(1_234_567, INDIA)).toBe("12,34,567");
    expect(currencySign(INDIA)).toBe("₹");
    expect(currencySign()).toBe("$");
    expect(formatDate("2026-11-14", INDIA)).toBe("14 Nov 2026");
    expect(formatDay("2026-10-15", INDIA)).toBe("15 Oct");
    expect(dayRange("2026-12-28", "2026-12-31", INDIA)).toBe("28–31 Dec");
    expect(dayRange("2026-09-30", "2026-10-02", INDIA)).toBe("30 Sep – 2 Oct");
    expect(displayValue({ type: "money_range" }, { from: 90_000_000, to: 120_000_000 }, {}, INDIA)).toBe("₹9,00,000 – ₹12,00,000");
    expect(displayValue({ type: "number" }, 1_234_567, {}, INDIA)).toBe("12,34,567");
    expect(displayValue({ type: "datetime" }, "2026-11-14T09:30:00Z", {}, INDIA)).toBe("14 Nov 2026, 09:30");
    expect(formatMoney(100_000, { ...INDIA, currency: "EUR", grouping: "standard" })).toBe("€1,000");
  });

  it("empty settings read as dollars, from January", () => {
    expect(formatsOf({})).toEqual({ currency: "USD", grouping: "standard", dates: "mdy", yearStart: 1 });
    expect(formatsOf({ currency: "INR", numberGrouping: "indian", dateStyle: "dmy", fiscalYearStart: 4 })).toEqual(INDIA);
  });
});
