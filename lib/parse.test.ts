import { describe, expect, it } from "vitest";
import { inputText, parseDate, parseInput, formatMoneyTyping } from "./parse";

describe("parse", () => {
  it("reads dates people write, never ambiguous ones", () => {
    expect(parseDate("Nov 15, 2025")).toBe("2025-11-15");
    expect(parseDate("november 15 2025")).toBe("2025-11-15");
    expect(parseDate("15 Nov 2025")).toBe("2025-11-15");
    expect(parseDate("2025-11-15")).toBe("2025-11-15");
    expect(parseDate("Feb 30, 2026")).toBeNull();
    expect(parseDate("03/02/2025")).toBeNull();
  });

  it("turns typed text into stored values", () => {
    expect(parseInput("money", "$ 41,000", "Value a year")).toEqual({ ok: true, value: 4_100_000 });
    expect(parseInput("money", "82.50", "Amount")).toEqual({ ok: true, value: 8_250 });
    expect(parseInput("money", "lots", "Value a year")).toEqual({ ok: false, error: "Value a year must be an amount, like 41,000." });
    expect(parseInput("days", "30 days", "Notice")).toEqual({ ok: true, value: 30 });
    expect(parseInput("days", "2.5", "Notice").ok).toBe(false);
    expect(parseInput("money_range", "90,000 – 120,000", "Salary band")).toEqual({ ok: true, value: { from: 9_000_000, to: 12_000_000 } });
    expect(parseInput("datetime", "Oct 28, 2026 14:30", "When")).toEqual({ ok: true, value: "2026-10-28T14:30:00.000Z" });
    expect(parseInput("text", "  Northwind ", "Customer")).toEqual({ ok: true, value: "Northwind" });
    expect(parseInput("date", "", "Start")).toEqual({ ok: true, value: null });
  });

  it("writes stored values back as form text", () => {
    expect(inputText("money", 3_840_000)).toBe("38,400");
    expect(inputText("days", 30)).toBe("30 days");
    expect(inputText("date", "2025-11-15")).toBe("Nov 15, 2025");
    for (const [type, text] of [["money", "41,000"], ["date", "Nov 14, 2026"], ["days", "60 days"]] as const) {
      const p = parseInput(type, text, "x");
      expect(p.ok && inputText(type, p.value)).toBe(text);
    }
  });
});

describe("formatMoneyTyping", () => {
  it("adds thousands separators as amounts are typed, keeping the cursor after the same digits", () => {
    expect(formatMoneyTyping("12000", 5)).toEqual({ text: "12,000", caret: 6 });
    expect(formatMoneyTyping("1200", 4)).toEqual({ text: "1,200", caret: 5 });
    expect(formatMoneyTyping("123", 3)).toEqual({ text: "123", caret: 3 });
    // A digit typed in the middle: "1,2|00" + "5" → "12,5|00".
    expect(formatMoneyTyping("1,2500", 4)).toEqual({ text: "12,500", caret: 4 });
    // A comma deleted by Backspace leaves the digits as they were.
    expect(formatMoneyTyping("12000", 2)).toEqual({ text: "12,000", caret: 2 });
  });
  it("keeps cents, ranges and anything else as typed", () => {
    expect(formatMoneyTyping("1234.5", 6)).toEqual({ text: "1,234.5", caret: 7 });
    expect(formatMoneyTyping("1234.", 5)).toEqual({ text: "1,234.", caret: 6 });
    expect(formatMoneyTyping("90000-120000", 12).text).toBe("90,000-120,000");
    expect(formatMoneyTyping("$1,2a3", 6).text).toBe("$12a3");
    expect(formatMoneyTyping("", 0)).toEqual({ text: "", caret: 0 });
  });

  it("a company's own money and dates (M26)", () => {
    const india = { currency: "INR", grouping: "indian", dates: "dmy", yearStart: 4 } as const;
    expect(formatMoneyTyping("1234567", 7, "indian").text).toBe("12,34,567");
    expect(formatMoneyTyping("12000", 5, "indian").text).toBe("12,000");
    expect(formatMoneyTyping("900000-1200000", 14, "indian").text).toBe("9,00,000-12,00,000");
    expect(parseInput("money", "₹12,34,567", "Value")).toEqual({ ok: true, value: 123_456_700 });
    expect(inputText("money", 123_456_700, india)).toBe("12,34,567");
    expect(inputText("date", "2026-11-14", india)).toBe("14 Nov 2026");
    expect(parseInput("date", "14 Nov 2026", "Start", india)).toEqual({ ok: true, value: "2026-11-14" });
    expect(parseInput("date", "soon", "Start", india)).toEqual({ ok: false, error: "Start must be a date, like 15 Nov 2025." });
  });
});
