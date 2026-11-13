import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// The open Bike updated, rolled back and restored from its images (scripts/update-run.sh starts each install; nothing is started here).
export default defineConfig({
  testDir: "tests/update-run",
  outputDir: path.join(os.tmpdir(), "bike-update-run-results"),
  workers: 1,
  timeout: 120_000,
  use: { headless: true, viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
});
