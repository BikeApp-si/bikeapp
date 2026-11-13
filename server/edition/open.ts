import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { workspaces } from "@/db/schema";
import { withWorkspace } from "@/server/kernel/tx";
import { aiCap } from "@/server/kernel/instance-settings";
import { spentThisMonth } from "@/server/ai/use";
import type { Edition, Route } from "./types";

// The Bike a company runs for itself: one company at one address (INSTANCE_URL). No subdomain is read, and there
// is no sign-up, trial, credits or website. The workspace keeps its id and its address in the database, and
// row-level security stays on, so everything after the host is the same code as the hosted service.

export function instanceUrl(env: Record<string, string | undefined> = process.env): URL {
  return new URL(env.INSTANCE_URL || "http://localhost:3000");
}

export function sameHost(host: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  return (host ?? "").toLowerCase() === instanceUrl(env).host.toLowerCase();
}

export const CAP_REACHED = (cap: number) =>
  `This month’s AI cap of $${cap % 1 ? cap.toFixed(2) : cap} is reached, so building and changing apps waits until the 1st. An admin can raise it in Settings › AI.`;

async function capReached(workspaceId: string): Promise<string | null> {
  const cap = await aiCap();
  if (cap === null) return null;
  const spent = await withWorkspace({ workspaceId }, (tx) => spentThisMonth(tx));
  return spent >= cap ? CAP_REACHED(cap) : null;
}

export const MANY_COMPANIES = (n: number) => `Its database holds ${n} companies, and a company’s own Bike serves only one. Point Bike at a database with only your company in it.`;

// The companies in the database (the worker's one look across workspaces): the one company's address, read in
// its own transaction; with more than one, only how many there are matters.
async function companiesInDatabase(): Promise<string[]> {
  const found = await db().execute<{ id: string }>(sql`select id from all_workspaces()`);
  if (found.length !== 1) return found.map((w) => w.id);
  const [w] = await withWorkspace({ workspaceId: found[0]!.id }, (tx) => tx.select({ subdomain: workspaces.subdomain }).from(workspaces));
  return w ? [w.subdomain] : [];
}

const TTL_MS = 30_000;
const NONE_TTL_MS = 5_000; // more than one company: looked at again soon after it's fixed
const DOCS = "https://bikeapp.si/docs";

// companies: who is in the database; tests pass their own.
export function openEditionWith(companies: () => Promise<string[]>, log: (line: string) => void = console.error): Edition & { forget(): void } {
  let cached: { subdomain: string | null; count: number; at: number } | null = null;
  let warned = false;

  // The one company in this database. With none, first run; with more, none is served and it is said once.
  async function theCompany(): Promise<{ subdomain: string | null; count: number }> {
    if (cached && Date.now() - cached.at < (cached.subdomain ? TTL_MS : NONE_TTL_MS)) return cached;
    const all = await companies();
    if (all.length > 1 && !warned) {
      warned = true;
      log(`This Bike can’t open. ${MANY_COMPANIES(all.length)}`);
    }
    const found = { subdomain: all.length === 1 ? all[0]! : null, count: all.length, at: Date.now() };
    // Before first run, asked again on every request: the company it makes is served at once, in every process.
    cached = all.length === 0 ? null : found;
    return found;
  }

  const at = (path: string) => new URL(path, instanceUrl()).toString();

  return {
    async route(host): Promise<Route> {
      if (!sameHost(host)) return { kind: "none" };
      const { subdomain, count } = await theCompany();
      if (subdomain) return { kind: "workspace", subdomain };
      return count === 0 ? { kind: "firstRun" } : { kind: "none", companies: count };
    },
    oneCompany: () => true,
    secureCookies: () => process.env.NODE_ENV === "production" && instanceUrl().protocol === "https:",
    workspaceUrl: (_subdomain, path = "/") => at(path),
    emailLogoUrl: () => at("/email-logo.png"),
    docsUrl: () => DOCS,
    authFooter: () => [],
    createCompanyUrl: () => null,
    // Building and changing apps stop for the month once its AI use reaches the cap in Settings › AI (O3).
    beforeBuild: async (workspaceId) => capReached(workspaceId),
    creditsFor: () => 0,
    adminCredits: async () => null,
    replyTo: () => null,
    trialEndsAt: () => null,
    siteNotFound: () => null,
    // Look again on the next request (tests; the line about many companies is still said once).
    forget() {
      cached = null;
    },
  };
}

export const openEdition = openEditionWith(companiesInDatabase);

export const edition: Edition = openEdition;
