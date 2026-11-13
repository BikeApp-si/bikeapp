import { describe, expect, it } from "vitest";
import { edition } from "@/edition";
import { codeEmail } from "./code";
import { markUrl } from "./header";
import { morningEmail } from "./morning";
import { notifyEmail } from "./notify";
import { readyEmail } from "./ready";

// Every email opens with the company's logo once it has one, Bike's B until then (and for sign-up).

const company = (logoId: string | null) => markUrl({ subdomain: "fernwood", logoId });

describe("the mark at the top of every email", () => {
  it("is the company's logo once uploaded, from its own address; Bike's B otherwise", () => {
    expect(company("u1")).toBe(edition.workspaceUrl("fernwood", "/logo?v=u1"));
    expect(company(null)).toMatch(/\/email-logo\.png$/);
    expect(markUrl(null)).toMatch(/\/email-logo\.png$/);
  });

  it("is in the code, morning, notify and ready emails", () => {
    const mark = company("u1");
    const at = new Date("2026-10-27T10:00:00Z");
    const emails = [
      codeEmail({ to: "maya@fernwood.dev", firstName: "Maya", company: "Fernwood Labs", code: "K7P2QX", browser: null, os: null, city: null, at, timeZone: "UTC", mark }),
      morningEmail({ to: "maya@fernwood.dev", firstName: "Maya", company: "Fernwood Labs", subdomain: "fernwood", mark, date: "2026-10-27", items: [] }),
      notifyEmail({ to: "maya@fernwood.dev", subdomain: "fernwood", mark, payload: { message: "Hi", capabilityId: "c", capability: "Spend", sheet: "s", rowId: "r", row: "Taxi" } }),
      readyEmail({ to: "maya@fernwood.dev", subdomain: "fernwood", mark, payload: { capabilityId: "c", capability: "Spend" } }),
    ];
    for (const e of emails) expect(e.html).toContain(`<img src="${mark}"`);
  });
});
