import { describe, expect, it } from "vitest";
import { US, type Formats } from "@/lib/format";
import { companyWays } from "./shared";
import { reportWriter } from "./report-writer@3";

// What the prompts are told about a company's money, dates and year (M26): nothing for Bike's defaults, so their
// requests stay exactly as recorded; for a company in India, rupees, day-first dates and an April year.
const INDIA: Formats = { currency: "INR", grouping: "indian", dates: "dmy", yearStart: 4 };

describe("company ways", () => {
  it("says nothing for dollars, month-first dates and a year from January", () => {
    expect(companyWays(US, ["money", "year", "dates", "write"])).toBe("");
    expect(companyWays(undefined, ["money"])).toBe("");
  });

  it("names the currency, the financial year's quarters and how to write amounts", () => {
    const said = companyWays(INDIA, ["money", "year", "dates", "write"]);
    expect(said).toContain("Indian Rupee (INR), not dollars");
    expect(said).toContain("starts in April");
    expect(said).toContain("Q1 April–June, Q2 July–September, Q3 October–December, Q4 January–March");
    expect(said).toContain("14/11/2026 is November 14, 2026");
    expect(said).toContain('"₹95,300" and "₹1,23,45,600"');
    expect(said).toContain('"27 Oct"');
    // Only the parts a prompt asks for.
    expect(companyWays(INDIA, ["year"])).not.toContain("Rupee");
  });

  it("leaves a default company's report request as it was", () => {
    const input = { company: { name: "Fernwood Labs", timeZone: "America/Chicago" }, today: "2026-10-26", user: "Wade", capabilities: [], facts: [], people: [], conversation: [], currentReport: null, latestMessage: "Spend by team" };
    expect(reportWriter.render({ ...input, formats: US })).toEqual(reportWriter.render(input));
    expect(reportWriter.render({ ...input, formats: INDIA }).message).toContain("financial year starts in April");
  });
});
