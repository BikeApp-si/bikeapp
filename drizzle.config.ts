import { defineConfig } from "drizzle-kit";

try { process.loadEnvFile(); } catch {}

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema/index.ts",
  out: "./db/migrations",
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL ?? "" },
});
