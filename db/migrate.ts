// Runs migrations as the owner role. Usage: pnpm db:migrate [--test]
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { direct } from "./urls";

try { process.loadEnvFile(); } catch {}

export async function runMigrations(url: string) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: "db/migrations" });
  await sql.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.argv.includes("--test") ? process.env.TEST_DATABASE_ADMIN_URL : process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error("Set DATABASE_ADMIN_URL (or TEST_DATABASE_ADMIN_URL) in .env");
  await runMigrations(direct(url));
  console.log("Migrations done");
}
