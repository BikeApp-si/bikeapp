// Drops and re-creates the local dev database, then runs the migrations and the seed.
// Usage: pnpm db:reset. Refuses any database that isn't on this machine.
import { resetDatabase } from "./reset-database";

try { process.loadEnvFile(); } catch {}

const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) throw new Error("Set DATABASE_ADMIN_URL and DATABASE_URL in .env");

try {
  const result = await resetDatabase({ adminUrl, appUrl });
  console.log(`Database ${result.name} re-created, migrated and seeded (Fernwood capabilities ${result.fernwood.capabilitiesSeeded ? "seeded" : "already there"}, Acme)`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
