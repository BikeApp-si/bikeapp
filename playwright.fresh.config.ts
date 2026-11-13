import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// The open Bike installed from its image on empty volumes (scripts/fresh-run.sh starts it; nothing is started here).
export default defineConfig({
  testDir: "tests/fresh-run",
  outputDir: path.join(os.tmpdir(), "bike-fresh-run-results"),
  workers: 1,
  timeout: 120_000,
  use: { headless: true, viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
});
