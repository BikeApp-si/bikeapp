import { describe, expect, it } from "vitest";
import type { ReportView } from "@/server/kernel/report/view";
import { reportHtml } from "./pdf";
import { US } from "@/lib/format";

// 11h's page, as HTML before Chromium prints it: the title line with the period, the sources, who made it and
// when (with the year), the table with its total, and how it was worked out.

const VIEW: ReportView = {
  id: "r1",
  title: "Spend by team, Q4",
  ranAt: "Oct 26, 10:02",
  ranOn: "Oct 26, 2026, 10:02",
  firstId: null,
  sources: "Spend and Tools and budgets",
  period: "Oct 1–26, 2026",
  card: "Report · Spend, Tools and budgets · 128 purchases",
  how: ["Budget: each team’s Q4 budget in Tools and budgets."],
  chart: { kind: "none", labels: [], formats: US, series: [] },
  table: { columns: ["Team", "Budget"], rows: [["Engineering", "$60,000"]], numeric: [false, true] },
  print: { columns: ["Team", "Budget"], rows: [["Engineering", "$60,000"], ["Sales", "$30,000"]], total: ["Total", "$90,000"], numeric: [false, true] },
  csv: { columns: ["Team", "Budget"], rows: [["Engineering", 60000]] },
};

describe("the report PDF's page", () => {
  it("says what, from where, by whom and when, with the total", async () => {
    const html = await reportHtml(VIEW, { by: "Wade Wilson", workspace: "Fernwood Labs", address: "fernwood.bikeapp.si" });
    expect(html).toContain("Oct 1–26, 2026 · from Spend and Tools and budgets · made by Wade Wilson on Oct 26, 2026, 10:02");
    expect(html).toContain('<tr class="total"><td>Total</td><td>$90,000</td></tr>');
    expect(html).toContain("Fernwood Labs · fernwood.bikeapp.si");
  });
});
