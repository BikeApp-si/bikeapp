// The one clock. Every time the app writes or compares (Audit entries, rows, versions, sessions, codes, date
// rules) comes from here, so nothing mixes the app's time with the database's.
//
// BIKE_TODAY (YYYY-MM-DD) pins the date outside production, for the seed's screens, tests and the Playwright
// server: the clock starts at 15:00 UTC that day (10:00 in Chicago) and runs on from there, so expiries and
// the order of writes still work. It is refused in production, except for Playwright's own production build
// (BIKE_E2E=1, served on a localhost address).

const STARTED = Date.now();

// Playwright's own production build, served on a localhost address (ROOT_HOST, or INSTANCE_URL for the open Bike's
// flows); never bikeapp.si or a company's own server.
const LOCAL = /^localhost:\d+$/;
const instanceHost = (url: string | undefined) => {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return "";
  }
};
export const isE2E = (env: NodeJS.ProcessEnv = process.env) => env.BIKE_E2E === "1" && (LOCAL.test(env.ROOT_HOST ?? "") || LOCAL.test(instanceHost(env.INSTANCE_URL)));

export function pinnedDay(env: NodeJS.ProcessEnv = process.env): string | null {
  const day = env.BIKE_TODAY?.trim();
  if (!day) return null;
  if (env.NODE_ENV === "production" && !isE2E(env)) throw new Error("BIKE_TODAY is for development and tests only. Remove it from the production environment.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new Error(`BIKE_TODAY must be a date like 2026-10-27, not “${day}”.`);
  return day;
}

// Checked when the app or the worker starts, so a production setting stops it before it serves anything.
export function checkClock(env: NodeJS.ProcessEnv = process.env): void {
  pinnedDay(env);
}

// Frozen at one instant while fn runs, for writes that must come out the same every time (the seed's AI steps).
let frozen: Date | null = null;
export async function atInstant<T>(at: Date, fn: () => Promise<T>): Promise<T> {
  const before = frozen;
  frozen = at;
  try {
    return await fn();
  } finally {
    frozen = before;
  }
}

export function currentTime(): Date {
  if (frozen) return new Date(frozen);
  const day = pinnedDay();
  if (!day) return new Date();
  return new Date(Date.parse(`${day}T15:00:00Z`) + (Date.now() - STARTED));
}
