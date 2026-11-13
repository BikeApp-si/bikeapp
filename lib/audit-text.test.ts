import { describe, expect, it } from "vitest";
import { detailsText } from "./audit-text";

describe("detailsText", () => {
  it("writes recorded details as one line, in order", () => {
    expect(detailsText({ sheet: "Contracts", row: "Northwind", changes: [{ column: "value", name: "Value a year", from: 38400, to: 41000 }] })).toBe(
      "Contracts/Northwind · Value a year 38400 → 41000",
    );
    expect(detailsText({ sheet: "Contracts", row: "Acme Health", from: "Active", to: "Renewal due" })).toBe("Contracts/Acme Health · Active → Renewal due");
    expect(detailsText({ from: 2, to: 3, change: "sheet added “Interviews”" })).toBe("v2 → v3 · sheet added “Interviews”");
    expect(detailsText({ file: "contracts.csv", rows: 12, decided: ["Sable Analytics", "Brightline"] })).toBe("contracts.csv · 12 rows · 2 decided (Sable Analytics, Brightline)");
    expect(detailsText({ version: 1, summary: "1 sheet, 5 steps, 2 rules, 2 roles" })).toBe("v1 · 1 sheet, 5 steps, 2 rules, 2 roles");
    expect(detailsText({ source: "seed", added: 13, managerNotFound: 2 })).toBe("seed · 13 added · 2 manager not found");
    expect(detailsText({ name: { from: "Fernwood", to: "Fernwood Labs" } })).toBe("name Fernwood → Fernwood Labs");
  });
});
