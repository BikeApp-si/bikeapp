import { afterEach, describe, expect, it, vi } from "vitest";
import { instanceUrl, MANY_COMPANIES, openEditionWith, sameHost } from "./open";

// The open Bike: one company at INSTANCE_URL, nothing else reachable.
describe("the open edition", () => {
  const before = process.env.INSTANCE_URL;
  afterEach(() => {
    process.env.INSTANCE_URL = before;
  });

  const withCompanies = (...subs: string[]) => {
    const lines: string[] = [];
    return { edition: openEditionWith(async () => subs, (l) => lines.push(l)), lines };
  };

  it("serves its one company on its own address only", async () => {
    process.env.INSTANCE_URL = "https://bike.fernwood.example";
    const { edition } = withCompanies("fernwood");
    expect(await edition.route("bike.fernwood.example")).toEqual({ kind: "workspace", subdomain: "fernwood" });
    expect(await edition.route("BIKE.Fernwood.example")).toEqual({ kind: "workspace", subdomain: "fernwood" });
    for (const host of ["fernwood.bike.fernwood.example", "fernwood.localhost:3000", "localhost:3000", "bikeapp.si", "www.bike.fernwood.example", "", null])
      expect(await edition.route(host)).toEqual({ kind: "none" });
  });

  it("never leads to the website, sign-up or a trial", async () => {
    process.env.INSTANCE_URL = "http://localhost:3200";
    const { edition } = withCompanies("fernwood");
    expect((await edition.route("localhost:3200")).kind).not.toBe("site");
    expect(edition.createCompanyUrl()).toBeNull();
    expect(edition.authFooter()).toEqual([]);
    expect(edition.trialEndsAt(new Date())).toBeNull();
    expect(edition.siteNotFound()).toBeNull();
    expect(await edition.beforeBuild("any")).toBeNull();
    expect(edition.creditsFor(12.5)).toBe(0);
    expect(edition.replyTo()).toBeNull();
  });

  it("with no company yet, leads to first run, looking again on every request", async () => {
    process.env.INSTANCE_URL = "http://localhost:3200";
    const found: string[] = [];
    const edition = openEditionWith(async () => [...found]);
    expect(await edition.route("localhost:3200")).toEqual({ kind: "firstRun" });
    expect(await edition.route("fernwood.localhost:3200")).toEqual({ kind: "none" });
    found.push("fernwood");
    expect(await edition.route("localhost:3200")).toEqual({ kind: "workspace", subdomain: "fernwood" });
    expect(edition.oneCompany()).toBe(true);
  });

  it("with more than one company, serves none and says why once", async () => {
    process.env.INSTANCE_URL = "http://localhost:3200";
    const two = withCompanies("fernwood", "juniper");
    expect(await two.edition.route("localhost:3200")).toEqual({ kind: "none", companies: 2 });
    two.edition.forget();
    expect(await two.edition.route("localhost:3200")).toEqual({ kind: "none", companies: 2 });
    expect(two.lines).toEqual([`This Bike can’t open. ${MANY_COMPANIES(2)}`]);
  });

  it("links to its own address in emails, whatever the company's stored address", () => {
    process.env.INSTANCE_URL = "https://bike.fernwood.example";
    const { edition } = withCompanies("fernwood");
    expect(edition.workspaceUrl("fernwood", "/c/1?sheet=2&row=3")).toBe("https://bike.fernwood.example/c/1?sheet=2&row=3");
    expect(edition.emailLogoUrl()).toBe("https://bike.fernwood.example/email-logo.png");
    expect(new URL(edition.workspaceUrl("fernwood")).host).toBe("bike.fernwood.example");
  });

  it("sends cookies over HTTPS only when its address is https", () => {
    const { edition } = withCompanies("fernwood");
    vi.stubEnv("NODE_ENV", "production");
    process.env.INSTANCE_URL = "https://bike.fernwood.example";
    expect(edition.secureCookies()).toBe(true);
    process.env.INSTANCE_URL = "http://10.0.0.5:3000";
    expect(edition.secureCookies()).toBe(false);
    vi.stubEnv("NODE_ENV", "development");
    process.env.INSTANCE_URL = "https://bike.fernwood.example";
    expect(edition.secureCookies()).toBe(false);
    vi.unstubAllEnvs();
  });

  it("reads its address from INSTANCE_URL, localhost:3000 when unset", () => {
    expect(instanceUrl({}).host).toBe("localhost:3000");
    expect(sameHost("bike.acme.example:8443", { INSTANCE_URL: "https://bike.acme.example:8443/" })).toBe(true);
    expect(sameHost("bike.acme.example", { INSTANCE_URL: "https://bike.acme.example:8443/" })).toBe(false);
  });
});
