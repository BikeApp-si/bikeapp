import { describe, expect, it } from "vitest";
import { checkClock, currentTime, pinnedDay } from "./clock";
import { todayIn } from "./context";

describe("the clock", () => {
  it("is pinned to BIKE_TODAY outside production, as tests run it (2026-10-27)", () => {
    expect(pinnedDay()).toBe("2026-10-27");
    expect(todayIn("America/Chicago")).toBe("2026-10-27");
    expect(todayIn("Asia/Singapore", currentTime())).toBe("2026-10-27");
  });

  it("runs on from there, so later writes come later", () => {
    const a = currentTime().getTime();
    const b = currentTime().getTime();
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it("is the real time when BIKE_TODAY isn't set", () => {
    expect(pinnedDay({ NODE_ENV: "development" })).toBeNull();
  });

  it("refuses BIKE_TODAY in production, and a value that isn't a date", () => {
    expect(() => checkClock({ NODE_ENV: "production", BIKE_TODAY: "2026-10-27" })).toThrow(/development and tests only/);
    expect(() => checkClock({ NODE_ENV: "production" })).not.toThrow();
    // Playwright's own production build may pin the date, on a localhost address only.
    expect(() => checkClock({ NODE_ENV: "production", BIKE_TODAY: "2026-10-27", BIKE_E2E: "1", ROOT_HOST: "localhost:3100" })).not.toThrow();
    expect(() => checkClock({ NODE_ENV: "production", BIKE_TODAY: "2026-10-27", BIKE_E2E: "1", ROOT_HOST: "bikeapp.si" })).toThrow(/development and tests only/);
    // The open Bike's flows (BIKE_MODE=single) on a localhost INSTANCE_URL; a company's own server is refused.
    expect(() => checkClock({ NODE_ENV: "production", BIKE_TODAY: "2026-10-27", BIKE_E2E: "1", INSTANCE_URL: "http://localhost:3200" })).not.toThrow();
    expect(() => checkClock({ NODE_ENV: "production", BIKE_TODAY: "2026-10-27", BIKE_E2E: "1", INSTANCE_URL: "https://bike.fernwood.example" })).toThrow(/development and tests only/);
    expect(() => checkClock({ NODE_ENV: "production", BIKE_TODAY: "2026-10-27", ROOT_HOST: "localhost:3100" })).toThrow(/development and tests only/);
    expect(() => checkClock({ NODE_ENV: "development", BIKE_TODAY: "Oct 27" })).toThrow(/must be a date/);
  });
});
