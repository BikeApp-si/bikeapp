import { afterEach, describe, expect, it } from "vitest";
import { edition } from "@/edition";
import { fullHealth } from "./health";

// The uptime monitor's check: ok when the database and the scanner answer, 503 naming what is down. The hosted
// service answers in a word; the open Bike lists every item of Settings › Instance (server/instance/health.test.ts).
const env = { ...process.env };
afterEach(() => void (process.env = { ...env }));
const open = () => edition.oneCompany();

describe("/healthz/full", () => {
  it("is ok when the database and the scanner answer", async () => {
    process.env.SCAN_PROVIDER = "memory";
    const health = await fullHealth();
    expect(health.status).toBe(200);
    if (open()) expect(health.body).toMatch(/^Database: ok\nFile storage: ok\nVirus scanner: ok\n/);
    else expect(health.body).toBe("ok");
  });

  it("answers 503 and names the scanner when it can't be reached", async () => {
    Object.assign(process.env, { SCAN_PROVIDER: "clamd", CLAMD_HOST: "127.0.0.1", CLAMD_PORT: "9" });
    const health = await fullHealth();
    expect(health.status).toBe(503);
    if (open()) expect(health.body).toContain("Virus scanner: not ok. Start it with docker compose up -d clamav.");
    else expect(health.body).toBe("down: scanner");
  });
});
