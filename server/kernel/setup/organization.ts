import { forgetSetup } from "../setup-cache";
import { eq } from "drizzle-orm";
import { workspaces } from "@/db/schema";
import { shortName } from "@/lib/address";
import { TIME_ZONES } from "@/lib/timezones";
import { MONTHS } from "@/lib/format";
import { currencyOf, isCountry } from "@/lib/places";
import { record } from "../audit";
import { mustBeAdmin } from "../admin";
import { KernelError, type KernelCtx } from "../context";
import type { Tx } from "../tx";

// Setup's organization (2b → 2c): what prompt 8 read from the admin's words, checked here, and what the
// kernel sets from the address. Nothing is saved until Continue to your team.

export type OrgReading = {
  name: string;
  address: { street?: string | null; city: string; region?: string | null; country: string } | null;
  what_it_does: string | null;
  business_model: string | null;
  products: string[];
  website?: string | null;
  missing: string[];
};

export const DOMAIN = /^([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i;

export const bareWebsite = (w: string) => w.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");

// What the model got wrong, in words it can fix on a retry. `said` is everything the admin wrote: a
// website must appear in it (prompt 8 never invents one).
export function checkOrganization(r: OrgReading, said: string): string[] {
  const problems: string[] = [];
  if (!r.name.trim()) problems.push("name is empty: use the company name you were given.");
  const country = r.address?.country;
  if (country && !isCountry(country)) problems.push(`address.country "${country}" isn't an ISO 3166 two-letter country code.`);
  if (r.website) {
    const site = bareWebsite(r.website);
    if (!DOMAIN.test(site)) problems.push(`website "${r.website}" isn't a web address.`);
    else if (!said.toLowerCase().includes(site.toLowerCase())) problems.push(`website "${r.website}" isn't in what the admin wrote; leave it empty.`);
  }
  return problems;
}

// "Central Time (US) · Austin" → "Central time".
export function timeZoneName(id: string): string {
  const label = TIME_ZONES.find((z) => z.id === id)?.label;
  if (!label || label === "UTC") return id;
  return label.split(" · ")[0]!.replace(/\s*\(.*\)/, "").replace(/( Standard)? Time$/, " time");
}

export type FromAddress = {
  currency: string | null;
  holidayCountry: string | null;
  fiscalYearStart: number;
  numberGrouping: "standard" | "indian";
  dateStyle: "mdy" | "dmy";
  timeZone: string;
};

// Where a company's year, numbers and dates aren't the default (M26): India; the UK and Australia (decided Nov 6), whose
// companies mostly keep their books from April and July and write the day first. Everyone else gets January to
// December, 1,234,567 and "Nov 14, 2026", and changes them in Settings.
const BY_COUNTRY: Record<string, Pick<FromAddress, "fiscalYearStart" | "numberGrouping" | "dateStyle">> = {
  IN: { fiscalYearStart: 4, numberGrouping: "indian", dateStyle: "dmy" },
  GB: { fiscalYearStart: 4, numberGrouping: "standard", dateStyle: "dmy" },
  AU: { fiscalYearStart: 7, numberGrouping: "standard", dateStyle: "dmy" },
};

// "Set from your address": never from the model.
export function fromAddress(country: string | null | undefined, timeZone: string): FromAddress {
  const known = country && isCountry(country) ? country : null;
  return {
    currency: known ? currencyOf(known) : null,
    holidayCountry: known,
    fiscalYearStart: 1,
    numberGrouping: "standard",
    dateStyle: "mdy",
    ...(known ? BY_COUNTRY[known] : undefined),
    timeZone,
  };
}

// 2c's line: "USD · Central time · Jan to Dec". No holiday count: holidays come from policy documents (M7).
export function fromAddressLine(f: FromAddress): string {
  const end = MONTHS[(f.fiscalYearStart + 10) % 12]!;
  const parts = [f.currency, timeZoneName(f.timeZone), `${MONTHS[f.fiscalYearStart - 1]} to ${end}`];
  return parts.filter(Boolean).join(" · ");
}

// "210 Congress Ave, Austin, TX".
export function addressLine(a: OrgReading["address"]): string {
  return a ? [a.street, a.city, a.region].filter((x) => x && x.trim()).join(", ") : "";
}

// Continue to your team: the organization and what comes from the address, in one Audit entry.
export async function saveOrganization(tx: Tx, ctx: KernelCtx, r: OrgReading) {
  await mustBeAdmin(tx, ctx);
  const [ws] = await tx.select().from(workspaces);
  if (!ws) throw new KernelError("No workspace.");
  const problems = checkOrganization(r, r.website ?? "");
  if (problems.length) throw new KernelError("Those details can't be saved. Reply to correct them.");
  const name = r.name.trim().slice(0, 80);
  const f = fromAddress(r.address?.country, ws.timeZone);
  const set = {
    name,
    shortName: shortName(name),
    street: r.address?.street ?? null,
    city: r.address?.city ?? null,
    addressRegion: r.address?.region ?? null,
    country: f.holidayCountry,
    website: r.website ? bareWebsite(r.website) : null,
    whatItDoes: r.what_it_does,
    businessModel: r.business_model,
    products: r.products,
    currency: f.currency,
    holidayCountry: f.holidayCountry,
    fiscalYearStart: f.fiscalYearStart,
    numberGrouping: f.numberGrouping,
    dateStyle: f.dateStyle,
  };
  await tx.update(workspaces).set(set).where(eq(workspaces.id, ctx.workspaceId));
  forgetSetup();
  const details: Record<string, unknown> = { from: "setup", address: addressLine(r.address), website: set.website, currency: set.currency };
  if (name !== ws.name) details.name = { from: ws.name, to: name };
  await record(tx, ctx, { who: ctx.actor.email, event: "settings.updated", details, at: ctx.now });
}
