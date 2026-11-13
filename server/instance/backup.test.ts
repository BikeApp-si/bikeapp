import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { kernelWorkspace } from "@/tests/kernel";
import {
  backupBeforeUpdate,
  backupName,
  BackupRefused,
  HAS_COMPANY,
  listBackups,
  makeBackup,
  nightlyBackup,
  parseName,
  readManifest,
  restoreBackup,
  TOO_NEW,
  toRemove,
  type Backup,
  type PgTools,
} from "./backup";

// O4's backups: one .tar (manifest, database, files), kept 7 nightly / 3 before-update / every manual one, and a
// restore only into a Bike with no company, never from a newer one. pg_dump and pg_restore are stood in for here
// (this machine's may be older than Postgres 16); the real ones run in scripts/update-run.sh.

const ADMIN = process.env.TEST_DATABASE_ADMIN_URL!;
const SCRATCH = "bike_backup_test";
const scratchUrl = () => {
  const u = new URL(ADMIN);
  u.pathname = `/${SCRATCH}`;
  return u.toString();
};

const fake: PgTools & { restored: string[] } = {
  restored: [],
  dump: async (_url, out) => writeFileSync(out, "the database"),
  restore: async (_url, file) => void fake.restored.push(readFileSync(file, "utf8")),
};

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "bike-backup-test-"));
const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  await kernelWorkspace(); // the test database has a company
  const sql = postgres(ADMIN, { max: 1, onnotice: () => {} });
  await sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH}`);
  await sql.unsafe(`CREATE DATABASE ${SCRATCH}`);
  await sql.end();
});
afterAll(async () => {
  const sql = postgres(ADMIN, { max: 1, onnotice: () => {} });
  await sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
  await sql.end();
});
beforeEach(() => void (fake.restored = []));

describe("a backup's name", () => {
  it("says the version, the time in UTC and why, and reads back", () => {
    const name = backupName("0.6.0", at("2026-11-13T02:00:41Z"), "nightly");
    expect(name).toBe("bike-0.6.0-2026-11-13-0200-nightly.tar");
    expect(parseName(name)).toEqual({ name, version: "0.6.0", at: at("2026-11-13T02:00:00Z"), why: "nightly" });
    expect(parseName(`${name}.part`)).toBeNull();
    expect(parseName("notes.txt")).toBeNull();
  });
});

describe("keeping", () => {
  const b = (day: number, why: Backup["why"]): Backup => ({ name: `${why}-${day}`, at: at(`2026-11-${String(day).padStart(2, "0")}T02:00:00Z`), why, version: "0.6.0", bytes: 1 });
  it("keeps the newest 7 nightly, 3 before-update and every manual one", () => {
    const list = [...Array.from({ length: 10 }, (_, i) => b(20 - i, "nightly")), ...Array.from({ length: 5 }, (_, i) => b(20 - i, "before-update")), ...Array.from({ length: 12 }, (_, i) => b(20 - i, "manual"))];
    list.sort((x, y) => y.at.getTime() - x.at.getTime());
    expect(toRemove(list).sort()).toEqual(["before-update-16", "before-update-17", "nightly-11", "nightly-12", "nightly-13"]);
  });
});

describe("making one", () => {
  it("holds the manifest, the database and the files, and leaves no .part", async () => {
    const dir = tmp();
    const files = tmp();
    mkdirSync(path.join(files, "ws", "a"), { recursive: true });
    writeFileSync(path.join(files, "ws", "a", "contract.pdf"), "pdf");
    const made = await makeBackup({ adminUrl: ADMIN, why: "manual", version: "0.6.0", filesDir: files, dir, now: at("2026-11-13T10:15:00Z"), tools: fake });
    expect(made).toMatchObject({ name: "bike-0.6.0-2026-11-13-1015-manual.tar", why: "manual" });
    expect(readdirSync(dir)).toEqual([made.name]);
    const file = path.join(dir, made.name);
    const m = await readManifest(file);
    expect(m).toMatchObject({ bike: "backup", madeBy: "0.6.0", why: "manual", madeAt: "2026-11-13T10:15:00.000Z" });
    expect(m.company).toBeTruthy();
    expect(m.migrations).toBeGreaterThan(40);
    const listing = execFileSync("tar", ["-tf", file], { encoding: "utf8" }).split("\n");
    expect(listing).toEqual(expect.arrayContaining(["manifest.json", "database.dump", "files/ws/a/contract.pdf"]));
    expect(execFileSync("tar", ["-xOf", file, "database.dump"], { encoding: "utf8" })).toBe("the database");
  });

  it("removes the oldest past keeping", async () => {
    const dir = tmp();
    for (let d = 1; d <= 8; d++) writeFileSync(path.join(dir, backupName("0.6.0", at(`2026-11-0${d}T02:00:00Z`), "nightly")), "x");
    await makeBackup({ adminUrl: ADMIN, why: "nightly", version: "0.6.0", filesDir: tmp(), dir, now: at("2026-11-09T02:00:00Z"), tools: fake });
    const left = (await listBackups(dir)).map((b) => b.at.getUTCDate());
    expect(left).toEqual([9, 8, 7, 6, 5, 4, 3]);
  });

  it("leaves nothing behind when the dump fails", async () => {
    const dir = tmp();
    const broken: PgTools = { ...fake, dump: async () => Promise.reject(new Error("No space left on device")) };
    await expect(makeBackup({ adminUrl: ADMIN, why: "manual", version: "0.6.0", filesDir: tmp(), dir, tools: broken })).rejects.toThrow("No space left");
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("before a database update", () => {
  it("backs up only with updates pending, and not again within 10 minutes", async () => {
    const dir = tmp();
    const opts = { adminUrl: ADMIN, version: "0.6.1", filesDir: tmp(), dir, tools: fake };
    expect(await backupBeforeUpdate({ ...opts, shipped: 1 })).toBeNull(); // nothing pending
    const now = at("2026-11-13T09:00:00Z");
    expect(await backupBeforeUpdate({ ...opts, shipped: 10_000, now })).toMatchObject({ why: "before-update" });
    expect(await backupBeforeUpdate({ ...opts, shipped: 10_000, now: at("2026-11-13T09:05:00Z") })).toBeNull();
    expect(await backupBeforeUpdate({ ...opts, shipped: 10_000, now: at("2026-11-13T09:20:00Z") })).toMatchObject({ why: "before-update" });
  });

  it("does nothing before first run (no company)", async () => {
    expect(await backupBeforeUpdate({ adminUrl: scratchUrl(), version: "0.6.1", filesDir: tmp(), dir: tmp(), tools: fake, shipped: 10_000 })).toBeNull();
  });
});

describe("nightly", () => {
  it("one a day from 02:00 in the company's time zone, none before first run", async () => {
    const dir = tmp();
    const sql = postgres(ADMIN, { max: 1 });
    const tz = (await sql`select time_zone from workspaces order by name limit 1`)[0]!.time_zone as string;
    await sql.end();
    const local = (iso: string) => {
      // The UTC instant when the company's clock reads iso (good enough for whole hours away from a DST change).
      const guess = new Date(`${iso}Z`);
      const shown = new Date(guess.toLocaleString("en-US", { timeZone: tz }));
      return new Date(guess.getTime() - (shown.getTime() - new Date(guess.toLocaleString("en-US", { timeZone: "UTC" })).getTime()));
    };
    const opts = { adminUrl: ADMIN, version: "0.6.0", filesDir: tmp(), dir, tools: fake };
    expect(await nightlyBackup({ ...opts, now: local("2026-11-13T01:00:00") })).toBeNull();
    expect(await nightlyBackup({ ...opts, now: local("2026-11-13T02:00:00") })).toMatchObject({ why: "nightly" });
    expect(await nightlyBackup({ ...opts, now: local("2026-11-13T03:00:00") })).toBeNull();
    expect(await nightlyBackup({ ...opts, now: local("2026-11-14T09:00:00") })).toMatchObject({ why: "nightly" });
    expect(await nightlyBackup({ ...opts, adminUrl: scratchUrl(), now: local("2026-11-15T02:00:00") })).toBeNull();
  });
});

describe("restoring", () => {
  const backupFile = async (migrations: number) => {
    const files = tmp();
    writeFileSync(path.join(files, "logo.png"), "logo");
    const dir = tmp();
    const made = await makeBackup({ adminUrl: ADMIN, why: "manual", version: "0.6.2", filesDir: files, dir, tools: fake });
    const file = path.join(dir, made.name);
    // The manifest as a Bike with this many updates would write it.
    const work = tmp();
    execFileSync("tar", ["-xf", file, "-C", work]);
    const m = JSON.parse(readFileSync(path.join(work, "manifest.json"), "utf8"));
    writeFileSync(path.join(work, "manifest.json"), JSON.stringify({ ...m, migrations }));
    execFileSync("tar", ["-cf", file, "-C", work, "manifest.json", "database.dump", "files"]);
    return file;
  };

  it("is refused into a Bike that has a company", async () => {
    const file = await backupFile(1);
    const err = await restoreBackup({ adminUrl: ADMIN, file, filesDir: tmp(), version: "0.6.0", shipped: 10_000, tools: fake }).catch((e) => e);
    expect(err).toBeInstanceOf(BackupRefused);
    expect(err.message).toMatch(/^This Bike already has a company in it \(/);
    expect(err.message).toBe(HAS_COMPANY(err.message.match(/\((.*)\)/)[1]));
    expect(fake.restored).toEqual([]);
  });

  it("is refused from a newer Bike", async () => {
    const file = await backupFile(60);
    await expect(restoreBackup({ adminUrl: scratchUrl(), file, filesDir: tmp(), version: "0.6.0", shipped: 49, tools: fake })).rejects.toThrow(TOO_NEW("0.6.2", "0.6.0"));
    expect(fake.restored).toEqual([]);
  });

  it("is refused for a file that isn't a backup", async () => {
    const f = path.join(tmp(), "notes.tar");
    writeFileSync(f, "hello");
    await expect(restoreBackup({ adminUrl: scratchUrl(), file: f, filesDir: tmp(), version: "0.6.0", shipped: 49, tools: fake })).rejects.toThrow("This file isn’t one of Bike’s backups.");
  });

  it("into an empty Bike replaces its database and files", async () => {
    const sql = postgres(scratchUrl(), { max: 1, onnotice: () => {} });
    await sql.unsafe("CREATE SCHEMA pgboss; CREATE TABLE pgboss.job (id int); CREATE TABLE public.leftover (id int)");
    const file = await backupFile(49);
    const files = tmp();
    writeFileSync(path.join(files, "health-check.txt"), "old");
    const m = await restoreBackup({ adminUrl: scratchUrl(), file, filesDir: files, version: "0.6.2", shipped: 49, tools: fake });
    expect(m.madeBy).toBe("0.6.2");
    expect(fake.restored).toEqual(["the database"]);
    const [left] = await sql`select to_regclass('public.leftover') as t, to_regnamespace('pgboss') as s, to_regnamespace('public') as p`;
    expect(left).toEqual({ t: null, s: null, p: "public" });
    await sql.end();
    expect(readdirSync(files)).toEqual(["logo.png"]);
    expect(existsSync(path.join(files, "health-check.txt"))).toBe(false);
  });
});
