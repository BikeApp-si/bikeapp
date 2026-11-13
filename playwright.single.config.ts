import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";
import { at, SINGLE_ENV, SINGLE_PORT } from "./tests/e2e-single/env";

// The open Bike's flows (BIKE_MODE=single): one company at one address, on its own production build (port 3200,
// its own .next-single folder) and its own database. `pnpm e2e:single`.
export default defineConfig({
  testDir: "tests/e2e-single",
  outputDir: path.join(os.tmpdir(), "bike-e2e-single-results"),
  globalSetup: "./tests/e2e-single/global-setup.ts",
  workers: 1,
  ...(process.env.CI ? { retries: 1, expect: { timeout: 10_000 } } : {}),
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    video: "retain-on-failure",
    launchOptions: { args: ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"] },
  },
  webServer: {
    command: `pnpm exec next build && pnpm exec next start --port ${SINGLE_PORT}`,
    url: at("/healthz"),
    reuseExistingServer: false,
    timeout: 300_000,
    env: { ...SINGLE_ENV, NEXT_DIST_DIR: ".next-single", BIKE_E2E: "1" },
  },
});
