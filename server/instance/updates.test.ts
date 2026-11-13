import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { instanceSettings } from "@/db/schema";
import { withRoot } from "@/server/kernel/tx";
import { releaseCheck } from "@/server/kernel/instance-settings";
import { kernelWorkspace } from "@/tests/kernel";
import { checkForRelease, isNewer, latestRelease, newerRelease, RELEASES } from "./updates";

// O4: the daily look for a newer release, and what Settings › Instance says about it.

const at = (iso: string) => new Date(iso);
const github = (tag: string, calls: string[] = []) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${url} ${new Headers(init?.headers).get("user-agent")}`);
    return new Response(JSON.stringify({ tag_name: tag, html_url: `https://github.com/BikeApp-si/bikeapp/releases/tag/${tag}` }), { status: 200 });
  }) as typeof fetch;
const offline = (async () => {
  throw new TypeError("fetch failed");
}) as typeof fetch;

const clear = () =>
  withRoot((tx) =>
    tx.insert(instanceSettings).values({ id: 1, updatedAt: new Date() }).onConflictDoUpdate({ target: instanceSettings.id, set: { latestVersion: null, latestUrl: null, releaseCheckedAt: null } }),
  );

beforeAll(async () => void (await kernelWorkspace()));
beforeEach(clear);

describe("versions", () => {
  it("compares as numbers, with or without a v", () => {
    expect(isNewer("0.6.1", "0.6.0")).toBe(true);
    expect(isNewer("v0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("0.6.0", "0.6.0")).toBe(false);
    expect(isNewer("0.5.9", "0.6.0")).toBe(false);
    expect(isNewer("0.6.1", "dev")).toBe(false);
  });
});

describe("asking GitHub", () => {
  it("sends a plain request and reads the newest release", async () => {
    const calls: string[] = [];
    expect(await latestRelease(github("v0.6.1", calls))).toEqual({ version: "0.6.1", url: "https://github.com/BikeApp-si/bikeapp/releases/tag/v0.6.1" });
    expect(calls).toEqual([`${RELEASES} Bike`]);
  });

  it("gives nothing when GitHub can't be reached or answers oddly", async () => {
    expect(await latestRelease(offline)).toBeNull();
    expect(await latestRelease((async () => new Response("{}", { status: 404 })) as typeof fetch)).toBeNull();
    expect(await latestRelease(github("nightly"))).toBeNull();
  });

  it("asks once a day, never when off or on a build with no version", async () => {
    const env = { BIKE_VERSION: "0.6.0" };
    expect(await checkForRelease({ env, now: at("2026-11-13T03:00:00Z"), get: github("v0.6.1") })).toBe(true);
    expect(await checkForRelease({ env, now: at("2026-11-13T20:00:00Z"), get: github("v0.6.2") })).toBe(false);
    expect((await releaseCheck()).version).toBe("0.6.1");
    expect(await checkForRelease({ env, now: at("2026-11-14T03:00:00Z"), get: github("v0.6.2") })).toBe(true);
    expect((await releaseCheck()).version).toBe("0.6.2");
    await clear();
    expect(await checkForRelease({ env: { ...env, UPDATE_CHECK: "off" }, get: github("v0.6.1") })).toBe(false);
    expect(await checkForRelease({ env: { BIKE_VERSION: "dev" }, get: github("v0.6.1") })).toBe(false);
    expect((await releaseCheck()).checkedAt).toBeNull();
  });

  it("keeps the last answer when GitHub can't be reached", async () => {
    await checkForRelease({ env: { BIKE_VERSION: "0.6.0" }, now: at("2026-11-13T03:00:00Z"), get: github("v0.6.1") });
    await checkForRelease({ env: { BIKE_VERSION: "0.6.0" }, now: at("2026-11-14T03:00:00Z"), get: offline });
    expect(await releaseCheck()).toMatchObject({ version: "0.6.1", checkedAt: at("2026-11-14T03:00:00Z") });
  });
});

describe("what Settings › Instance says", () => {
  it("a newer release only, and nothing when the check is off", async () => {
    await checkForRelease({ env: { BIKE_VERSION: "0.6.0" }, get: github("v0.6.1") });
    expect(await newerRelease({ BIKE_VERSION: "0.6.0" })).toEqual({ version: "0.6.1", url: "https://github.com/BikeApp-si/bikeapp/releases/tag/v0.6.1" });
    expect(await newerRelease({ BIKE_VERSION: "0.6.1" })).toBeNull();
    expect(await newerRelease({ BIKE_VERSION: "0.6.0", UPDATE_CHECK: "off" })).toBeNull();
    expect(await newerRelease({ BIKE_VERSION: "dev" })).toBeNull();
    await withRoot((tx) => tx.update(instanceSettings).set({ latestVersion: null }).where(eq(instanceSettings.id, 1)));
    expect(await newerRelease({ BIKE_VERSION: "0.6.0" })).toBeNull();
  });
});
