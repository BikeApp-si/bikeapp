// Drops and re-creates a local database, runs the migrations and the seed. Used by `pnpm db:reset` (the dev
// database) and by Playwright's global setup (its own database). Refuses any database that isn't on this
// machine.
import postgres from "postgres";
import { closeDb } from "./client";
import { TODAY } from "@/seed/capabilities/seeder";
import { runMigrations } from "./migrate";

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// also: more seeding after the seed, through the same connection (Playwright's Step 6 copy of Fernwood).
// only: Fernwood alone, for the single-company flows (BIKE_MODE=single).
export async function resetDatabase({ adminUrl, appUrl, also, only }: { adminUrl: string; appUrl: string; also?: () => Promise<unknown>; only?: "fernwood" }) {
  const target = new URL(adminUrl);
  for (const host of [target.hostname, new URL(appUrl).hostname]) {
    if (!LOCAL.has(host)) throw new Error(`A reset only runs against a database on localhost, not ${host}.`);
  }
  const name = decodeURIComponent(target.pathname.slice(1));
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error("Unexpected database name");
  if (decodeURIComponent(new URL(appUrl).pathname.slice(1)) !== name) throw new Error("The admin and app connections name different databases.");

  // Connect to the maintenance database to drop and re-create this one.
  const maintenance = new URL(adminUrl);
  maintenance.pathname = "/postgres";
  const sql = postgres(maintenance.toString(), { max: 1, onnotice: () => {} });
  await sql.unsafe(`drop database if exists "${name}" with (force)`);
  await sql.unsafe(`create database "${name}"`);
  await sql.end();

  await runMigrations(adminUrl);

  // The seed writes through the app's connection, as bike_app, on the seed's today (clock.ts).
  process.env.BIKE_TODAY ??= TODAY;
  const before = process.env.DATABASE_URL;
  process.env.DATABASE_URL = appUrl;
  await closeDb();
  try {
    const { seed, seedFernwoodOnly } = await import("@/seed");
    const seeded = only === "fernwood" ? await seedFernwoodOnly() : await seed();
    await also?.();
    return { name, ...seeded };
  } finally {
    await closeDb();
    process.env.DATABASE_URL = before;
  }
}
