import { describe, expect, it } from "vitest";
import { asc } from "drizzle-orm";
import { auditEntries, workspaces } from "@/db/schema";
import { freshWorkspace } from "@/tests/helpers";
import { withWorkspace } from "../tx";
import { addressLine, checkOrganization, fromAddress, fromAddressLine, saveOrganization, timeZoneName, type OrgReading } from "./organization";

const SAID = "Fernwood Labs, 210 Congress Ave, Austin TX. fernwood.dev. We build developer tools.";
const FERNWOOD: OrgReading = {
  name: "Fernwood Labs",
  address: { street: "210 Congress Ave", city: "Austin", region: "TX", country: "US" },
  what_it_does: "Builds developer tools for engineering teams",
  business_model: "Subscription, B2B",
  products: ["Fernwood CI", "Fernwood Trace"],
  website: "fernwood.dev",
  missing: [],
};
const TODAY = new Date("2026-10-28T12:00:00Z");

describe("organization", () => {
  it("sets currency, fiscal year and time zone from the address, and keeps the country for holidays later", () => {
    const f = fromAddress("US", "America/Chicago");
    expect(f).toEqual({ currency: "USD", holidayCountry: "US", fiscalYearStart: 1, numberGrouping: "standard", dateStyle: "mdy", timeZone: "America/Chicago" });
    expect(fromAddressLine(f)).toBe("USD · Central time · Jan to Dec");
    expect(fromAddress("SI", "Europe/Ljubljana").currency).toBe("EUR");
    expect(fromAddressLine(fromAddress(null, "UTC"))).toBe("UTC · Jan to Dec");
    // India (M26): rupees, 12,34,567, "14 Nov 2026" and April to March.
    const india = fromAddress("IN", "Asia/Kolkata");
    expect(india).toMatchObject({ currency: "INR", fiscalYearStart: 4, numberGrouping: "indian", dateStyle: "dmy" });
    expect(fromAddressLine(india)).toMatch(/^INR · .+ · Apr to Mar$/);
    // The UK and Australia: their currency, day-first dates, and years from April and July.
    expect(fromAddress("GB", "Europe/London")).toMatchObject({ currency: "GBP", fiscalYearStart: 4, numberGrouping: "standard", dateStyle: "dmy" });
    expect(fromAddressLine(fromAddress("AU", "Australia/Sydney"))).toMatch(/^AUD · .+ · Jul to Jun$/);
  });

  it("names time zones as people say them", () => {
    expect(timeZoneName("America/Chicago")).toBe("Central time");
    expect(timeZoneName("Asia/Kolkata")).toBe("India time");
    expect(timeZoneName("Europe/London")).toBe("UK time");
  });

  it("writes the address as 2c shows it", () => {
    expect(addressLine(FERNWOOD.address)).toBe("210 Congress Ave, Austin, TX");
    expect(addressLine({ city: "Ljubljana", country: "SI" })).toBe("Ljubljana");
  });

  it("refuses a country that isn't a code and a website nobody wrote", () => {
    expect(checkOrganization(FERNWOOD, SAID)).toEqual([]);
    expect(checkOrganization({ ...FERNWOOD, address: { city: "Austin", country: "USA" } }, SAID)[0]).toMatch(/ISO 3166/);
    expect(checkOrganization({ ...FERNWOOD, website: "fernwoodlabs.com" }, SAID)[0]).toMatch(/isn't in what the admin wrote/);
    expect(checkOrganization({ ...FERNWOOD, website: "https://www.fernwood.dev/" }, SAID)).toEqual([]);
  });

  it("saves on Continue to your team, with one settings.updated entry", async () => {
    const { workspaceId, personId, email } = await freshWorkspace();
    const ctx = { workspaceId, actor: { id: personId, email }, now: TODAY };
    await withWorkspace({ workspaceId, personId }, (tx) => saveOrganization(tx, ctx, FERNWOOD));
    const [ws] = await withWorkspace({ workspaceId }, (tx) => tx.select().from(workspaces));
    expect(ws).toMatchObject({ name: "Fernwood Labs", shortName: "Fernwood", city: "Austin", addressRegion: "TX", country: "US", website: "fernwood.dev", currency: "USD", holidayCountry: "US", fiscalYearStart: 1, products: ["Fernwood CI", "Fernwood Trace"] });
    const events = await withWorkspace({ workspaceId }, (tx) => tx.select().from(auditEntries).orderBy(asc(auditEntries.seq)));
    expect(events.map((e) => e.event)).toEqual(["workspace.created", "settings.updated"]);
  });
});
