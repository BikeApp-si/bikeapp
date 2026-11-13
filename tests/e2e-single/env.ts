// The open Bike's flows (BIKE_MODE=single): their own Next server on port 3200 at INSTANCE_URL, and their own
// database (bike_e2e_single) holding Fernwood alone, reset and seeded before each run.
import os from "node:os";
import path from "node:path";

try { process.loadEnvFile(); } catch {}

export const SINGLE_PORT = 3200;
export const INSTANCE = `localhost:${SINGLE_PORT}`;
export const at = (path = "/") => `http://${INSTANCE}${path}`;
// The seed's today (seed/capabilities/seeder.ts TODAY), for the server's clock (server/kernel/clock.ts).
export const SINGLE_TODAY = "2026-10-27";

function swapped(url: string | undefined, name: string) {
  if (!url) throw new Error("Set DATABASE_URL and DATABASE_ADMIN_URL in .env");
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

export const SINGLE_DATABASE_URL = process.env.SINGLE_DATABASE_URL ?? swapped(process.env.DATABASE_URL, "bike_e2e_single");
export const SINGLE_DATABASE_ADMIN_URL = process.env.SINGLE_DATABASE_ADMIN_URL ?? swapped(process.env.DATABASE_ADMIN_URL, "bike_e2e_single");

// What the server and the worker both run with: one company at its own address, recorded AI answers only.
export const SINGLE_ENV = {
  BIKE_MODE: "single",
  INSTANCE_URL: at(),
  DATABASE_URL: SINGLE_DATABASE_URL,
  DATABASE_ADMIN_URL: SINGLE_DATABASE_ADMIN_URL,
  BIKE_TODAY: SINGLE_TODAY,
  // A mail relay (Mailpit): without SMTP_URL the open Bike has none (fresh-run.spec.ts covers that).
  SMTP_URL: "smtp://localhost:1025",
  // Files on disk, as the open Bike's compose file keeps them.
  STORAGE_PROVIDER: "disk",
  FILES_DIR: path.join(os.tmpdir(), "bike-e2e-single-files"),
  AI_PROVIDER: "fixtures",
  ANTHROPIC_API_KEY: "",
  AI_MODEL_LARGE: "claude-sonnet-5-5",
  AI_MODEL_SMALL: "claude-haiku-5-5",
};
