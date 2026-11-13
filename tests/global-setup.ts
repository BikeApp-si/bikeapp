// Resets the test database and runs the migrations once per test run.
import postgres from "postgres";
import { runMigrations } from "@/db/migrate";

export default async function setup() {
  const url = process.env.TEST_DATABASE_ADMIN_URL;
  if (!url) throw new Error("Set TEST_DATABASE_ADMIN_URL in .env");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  await sql.unsafe("drop schema if exists drizzle cascade; drop schema public cascade; create schema public;");
  await sql.end();
  await runMigrations(url);
}
