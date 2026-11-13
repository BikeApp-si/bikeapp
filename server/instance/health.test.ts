import { mkdtemp, rm, chmod, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aiItem, backupsItem, clockItem, databaseItem, emailItem, healthItems, healthText, migrationsShipped, scannerItem, storageItem, when } from "./health";
import { backupName } from "./backup";
import { fullHealth } from "@/server/health";

// Settings › Instance: each item answers, and each can fail and say how to fix it (O2's Done when).

process.env.BACKUPS_DIR = mkdtempSync(path.join(os.tmpdir(), "bike-health-backups-"));
const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
  vi.unstubAllGlobals();
});

describe("the health check", () => {
  it("is all well on a working Bike", async () => {
    const items = await healthItems();
    expect(items.map((i) => i.name)).toEqual(["Database", "File storage", "Virus scanner", "Email", "Clock", "AI", "Backups"]);
    expect(items.filter((i) => !i.ok)).toEqual([]);
    expect(items.every((i) => i.fix === undefined)).toBe(true);
  });

  it("database: an update not applied, and no answer", async () => {
    expect(await databaseItem(migrationsShipped())).toEqual({ name: "Database", ok: true, says: "Answers, and every update to it is applied." });
    expect(await databaseItem(migrationsShipped() + 2)).toMatchObject({ ok: false, says: "2 updates to it aren’t applied.", fix: expect.stringContaining("docker compose restart web") });
    expect(await databaseItem(migrationsShipped(), async () => Promise.reject(new Error("ECONNREFUSED")))).toMatchObject({ ok: false, says: "Doesn’t answer.", fix: expect.stringContaining("docker compose ps postgres") });
  });

  it("file storage: on disk, and a folder Bike can't write to", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bike-health-"));
    Object.assign(process.env, { STORAGE_PROVIDER: "disk", FILES_DIR: dir });
    expect(await storageItem()).toEqual({ name: "File storage", ok: true, says: "On this server’s disk. A test file was saved, read and removed." });
    const shut = await mkdtemp(path.join(os.tmpdir(), "bike-health-shut-"));
    await chmod(shut, 0o500);
    process.env.FILES_DIR = shut;
    expect(await storageItem()).toEqual({
      name: "File storage",
      ok: false,
      says: `Bike can’t save files to ${shut}.`,
      fix: "Check that the files volume is mounted and that Bike may write to it, then run again.",
    });
    await chmod(shut, 0o700);
    await Promise.all([dir, shut].map((d) => rm(d, { recursive: true, force: true })));
  });

  it("backups: the newest, none yet, none for two days, and a folder Bike can't write to", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bike-health-backups-"));
    const now = new Date("2026-11-13T09:30:00Z");
    const tz = "Europe/Ljubljana";
    const opts = { dir, now, timeZone: tz, doneAt: async () => new Date("2026-11-12T08:00:00Z") };
    expect(await backupsItem(opts)).toEqual({ name: "Backups", ok: true, says: "None yet. The first is made tonight at 02:00." });
    expect(await backupsItem({ ...opts, doneAt: async () => new Date("2026-11-10T08:00:00Z") })).toMatchObject({ ok: false, says: "No backup in the last two days." });
    for (let d = 7; d <= 13; d++) await writeFile(path.join(dir, backupName("0.6.0", new Date(`2026-11-${String(d).padStart(2, "0")}T01:00:00Z`), "nightly")), "x".repeat(48_000_000 * (d === 13 ? 1 : 0) || 10));
    await writeFile(path.join(dir, backupName("0.6.0", new Date("2026-11-05T10:00:00Z"), "manual")), "x");
    expect(await backupsItem(opts)).toEqual({ name: "Backups", ok: true, says: "Last one today at 02:00, 48 MB. 7 nightly ones kept in the backups folder." });
    expect(await backupsItem({ ...opts, now: new Date("2026-11-15T09:30:00Z") })).toEqual({
      name: "Backups",
      ok: false,
      says: "No backup in the last two days.",
      fix: "Check that the worker is running (docker compose ps worker) and that the backups folder beside compose.yaml can be written. To make one now: docker compose exec web bike backup.",
    });
    await chmod(dir, 0o500);
    expect(await backupsItem(opts)).toMatchObject({ ok: false, says: "Bike can’t write to the backups folder.", fix: expect.stringContaining("docker compose up -d") });
    await chmod(dir, 0o700);
    await rm(dir, { recursive: true, force: true });
  });

  it("says when in the company's time zone", () => {
    const now = new Date("2026-11-13T09:30:00Z");
    expect(when(new Date("2026-11-13T01:00:00Z"), now, "Europe/Ljubljana")).toBe("today at 02:00");
    expect(when(new Date("2026-11-12T01:00:00Z"), now, "Europe/Ljubljana")).toBe("yesterday at 02:00");
    expect(when(new Date("2026-11-11T01:00:00Z"), now, "Europe/Ljubljana")).toBe("Nov 11 at 02:00");
  });

  it("virus scanner: no answer", async () => {
    expect(await scannerItem()).toEqual({ name: "Virus scanner", ok: true, says: "Answers, and caught the test virus." });
    Object.assign(process.env, { SCAN_PROVIDER: "clamd", CLAMD_HOST: "127.0.0.1", CLAMD_PORT: "9" });
    expect(await scannerItem()).toMatchObject({ ok: false, says: "Doesn’t answer.", fix: expect.stringContaining("docker compose up -d clamav") });
  });

  it("email: no relay, and a relay that doesn't answer", async () => {
    process.env.EMAIL_PROVIDER = "none";
    expect(await emailItem()).toMatchObject({ ok: false, says: "No mail relay is set.", fix: expect.stringContaining("Set SMTP_URL in .env") });
    Object.assign(process.env, { EMAIL_PROVIDER: "smtp", SMTP_URL: "smtp://127.0.0.1:9" });
    expect(await emailItem()).toMatchObject({ ok: false, says: "127.0.0.1 doesn’t answer.", fix: expect.stringContaining("SMTP_URL") });
  });

  it("clock: behind or ahead of the database", async () => {
    expect(await clockItem(async () => new Date())).toMatchObject({ ok: true, says: "Matches the database’s clock." });
    expect(await clockItem(async () => new Date(Date.now() + 4 * 60_000))).toMatchObject({ ok: false, says: "4 minutes behind the database.", fix: expect.stringContaining("NTP") });
    expect(await clockItem(async () => new Date(Date.now() - 61_000))).toMatchObject({ ok: false, says: "1 minute ahead of the database." });
    expect(await clockItem(async () => Promise.reject(new Error("down")))).toMatchObject({ ok: false });
  });

  it("AI: no key, a refused key, Anthropic out of reach", async () => {
    expect(await aiItem({})).toMatchObject({ ok: false, says: "No Anthropic key is set.", fix: expect.stringContaining("Settings › AI") });
    process.env.AI_PROVIDER = "anthropic"; // the key check skips Anthropic only with recorded answers
    const answer = (status: number) => vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));
    answer(200);
    expect(await aiItem({ ANTHROPIC_API_KEY: "sk-ant-good" })).toEqual({ name: "AI", ok: true, says: "Your Anthropic key works." });
    answer(401);
    expect(await aiItem({ ANTHROPIC_API_KEY: "sk-ant-bad" })).toMatchObject({ ok: false, says: "Anthropic refused the key.", fix: expect.stringContaining("in .env") });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    expect(await aiItem({ ANTHROPIC_API_KEY: "sk-ant-good" })).toMatchObject({ ok: false, says: "Anthropic can’t be reached." });
  });

  it("/healthz/full in the open Bike: every item and its fix, 503 when Bike can't work", async () => {
    process.env.BIKE_MODE = "single";
    expect(await fullHealth()).toEqual({ status: 200, body: "Database: ok\nFile storage: ok\nVirus scanner: ok\nEmail: ok\nClock: ok\nAI: ok\nBackups: ok\n" });
    Object.assign(process.env, { SCAN_PROVIDER: "clamd", CLAMD_HOST: "127.0.0.1", CLAMD_PORT: "9", EMAIL_PROVIDER: "none" });
    const down = await healthText();
    expect(down.status).toBe(503);
    expect(down.body).toContain("Virus scanner: not ok. Start it with docker compose up -d clamav.");
    expect(down.body).toContain("Email: not ok. Set SMTP_URL in .env");
    expect(down.body).not.toContain("127.0.0.1");
  });
});
