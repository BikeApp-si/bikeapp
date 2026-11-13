import { describe, expect, it } from "vitest";
import { US, type Formats } from "@/lib/format";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { axisMoney, ReportChart, wholeSteps } from "./report-chart";

const INDIA: Formats = { currency: "INR", grouping: "indian", dates: "dmy", yearStart: 4 };

describe("the chart's money axis", () => {
  it("reads thousands for dollars, and lakhs and crores in Indian grouping", () => {
    expect(axisMoney(0, US)).toBe("$0");
    expect(axisMoney(66_667, US)).toBe("$67k");
    expect(axisMoney(200_000, US)).toBe("$200k");
    expect(axisMoney(66_667, INDIA)).toBe("₹67k");
    expect(axisMoney(133_333, INDIA)).toBe("₹1.3L");
    expect(axisMoney(200_000, INDIA)).toBe("₹2L");
    expect(axisMoney(25_000_000, INDIA)).toBe("₹2.5Cr");
  });
});

describe("a chart of counts with many groups (#18, #19)", () => {
  const jobs = ["Completed, Normal", "Logged, Low", "Completed, Low", "Scheduled, Normal", "Scheduled, Low", "In progress, Low", "Logged, Normal", "Logged, Urgent", "In progress, Normal", "Scheduled, Urgent"];
  const chart = { kind: "bar", labels: jobs, series: [{ name: "Jobs", role: "measure", format: "number", values: [4, 4, 3, 3, 2, 2, 2, 2, 1, 1] }], formats: US } as unknown as Parameters<typeof ReportChart>[0]["chart"];
  const svg = renderToStaticMarkup(createElement(ReportChart, { chart }));

  it("steps its axis by whole numbers", () => {
    expect(wholeSteps(4)).toBe(6);
    expect(wholeSteps(3)).toBe(3);
    expect(wholeSteps(25)).toBe(30);
    expect(svg).not.toMatch(/1\.333|2\.667/);
    expect(svg).toMatch(/>2<\/text>/);
  });

  it("tilts labels that would run into each other, and keeps each one whole", () => {
    expect(svg.match(/rotate\(-35/g)).toHaveLength(10);
    for (const j of jobs) expect(svg).toContain(`<title>${j}</title>`);
  });

  it("keeps a few short labels level", () => {
    const few = renderToStaticMarkup(createElement(ReportChart, { chart: { ...chart, labels: ["Jul", "Aug", "Sep"], series: [{ ...chart.series[0]!, values: [1, 2, 3] }] } }));
    expect(few).not.toContain("rotate(");
  });
});
