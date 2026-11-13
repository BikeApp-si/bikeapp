import { defineConfig } from "vitest/config";
import path from "node:path";

try { process.loadEnvFile(); } catch {}

export default defineConfig({
  // "@/edition": the open Bike.
  resolve: { alias: [{ find: /^@\/edition$/, replacement: path.resolve(import.meta.dirname, "server/edition/open.ts") }, { find: "@", replacement: path.resolve(import.meta.dirname) }] },
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "tests/e2e/**", ".next/**"],
    globalSetup: ["tests/global-setup.ts"],
    fileParallelism: false,
    // GitHub's runners (CI set) are slower than a laptop: more time per test and per setup (a seeded
    // Fernwood) there; tests with their own timeout keep it.
    testTimeout: process.env.CI ? 30_000 : 5_000,
    hookTimeout: process.env.CI ? 120_000 : 10_000,
    // Tests talk to the test database only, as bike_app.
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
      TEST_DATABASE_ADMIN_URL: process.env.TEST_DATABASE_ADMIN_URL ?? "",
      SESSION_SECRET: process.env.SESSION_SECRET || "test-secret",
      ROOT_HOST: "localhost:3000",
      EMAIL_PROVIDER: "memory",
      STORAGE_PROVIDER: "memory",
      // Uploads are scanned by a stand-in that knows the EICAR test file; scan.clamd.test.ts uses the real one.
      SCAN_PROVIDER: "memory",
      // Recorded answers only: a test never calls the real API. The open Bike has a model only with a key (O3), so a
      // stand-in one is set; recorded answers never send it anywhere. Tests of no model set it empty themselves.
      AI_PROVIDER: "fixtures",
      ANTHROPIC_API_KEY: "sk-ant-recorded-answers-only-never-sent",
      AI_MODEL_LARGE: "claude-sonnet-5-5",
      AI_MODEL_SMALL: "claude-haiku-5-5",
      // The seed's today (clock.ts).
      BIKE_TODAY: "2026-10-27",
    },
  },
});
