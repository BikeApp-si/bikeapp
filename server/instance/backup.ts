import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, rename, rm, stat, symlink, writeFile, cp, access } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";

// The open Bike's backups (O4, plan §10b): one .tar per backup in the backups folder (./backups beside
// compose.yaml), holding manifest.json, the database (pg_dump's own format, as the owner) and the files. Made
// nightly by the worker, before a database update (docker/start.sh), and by hand (`bike backup`); restored only
// into a Bike with no company yet (`bike restore`). .env is never in one: it is kept safe on its own.
// A restore replaces the database whole, like the database updates do; it is not a kernel write.

const run = promisify(execFile);

export type Why = "nightly" | "manual" | "before-update";
export type Manifest = { bike: "backup"; madeBy: string; why: Why; migrations: number; madeAt: string; company: string | null };
export type Backup = { name: string; at: Date; why: Why; version: string; bytes: number };

// pg_dump and pg_restore (16, in Bike's image); tests pass their own.
export type PgTools = { dump(url: string, out: string): Promise<void>; restore(url: string, file: string): Promise<void> };
export const pgTools: PgTools = {
  dump: async (url, out) => void (await run("pg_dump", ["--format=custom", `--dbname=${url}`, `--file=${out}`])),
  restore: async (url, file) => void (await run("pg_restore", ["--single-transaction", "--exit-on-error", `--dbname=${url}`, file])),
};

export const KEEP: Record<Why, number> = { nightly: 7, "before-update": 3, manual: Infinity };

export const backupsDir = (env: Record<string, string | undefined> = process.env) => path.resolve(env.BACKUPS_DIR ?? "/data/backups");

const pad = (n: number) => String(n).padStart(2, "0");

// bike-0.6.0-2026-11-13-0200-nightly.tar (the time in UTC): sorts by time within a version, says what made it.
export function backupName(version: string, at: Date, why: Why): string {
  const d = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}`;
  return `bike-${version}-${d}-${why}.tar`;
}

const NAME = /^bike-(.+)-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})-(nightly|manual|before-update)\.tar$/;

export function parseName(name: string): Omit<Backup, "bytes"> | null {
  const m = NAME.exec(name);
  if (!m) return null;
  const [, version, y, mo, d, h, mi, why] = m;
  return { name, version: version!, at: new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!)), why: why as Why };
}

// Finished backups, newest first (a .part, still being written, is not one).
export async function listBackups(dir = backupsDir()): Promise<Backup[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const found: Backup[] = [];
  for (const n of names) {
    const p = parseName(n);
    if (p) found.push({ ...p, bytes: (await stat(path.join(dir, n))).size });
  }
  return found.sort((a, b) => b.at.getTime() - a.at.getTime() || b.name.localeCompare(a.name));
}

// What to remove: past the newest 7 nightly and 3 before-update; manual ones stay.
export function toRemove(list: Backup[]): string[] {
  const seen: Record<Why, number> = { nightly: 0, "before-update": 0, manual: 0 };
  return list.filter((b) => ++seen[b.why] > KEEP[b.why]).map((b) => b.name);
}

type Db = { adminUrl: string };

async function withSql<T>(url: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

// The database's state, read as its owner: its company (none before first run) and its applied updates.
export async function databaseState(adminUrl: string): Promise<{ companies: string[]; migrations: number; timeZone: string | null }> {
  return withSql(adminUrl, async (sql) => {
    const [t] = await sql`select to_regclass('public.workspaces') as w, to_regclass('drizzle.__drizzle_migrations') as m`;
    const rows = t!.w ? await sql`select name, time_zone from workspaces order by name` : [];
    const migrations = t!.m ? Number((await sql`select count(*)::int as n from drizzle.__drizzle_migrations`)[0]!.n) : 0;
    return { companies: rows.map((r) => r.name as string), migrations, timeZone: (rows[0]?.time_zone as string | undefined) ?? null };
  });
}

export type MakeOpts = Db & { why: Why; version: string; filesDir: string; dir?: string; now?: Date; tools?: PgTools };

// Makes one backup and removes those past keeping. Written as .part, renamed when whole.
export async function makeBackup({ adminUrl, why, version, filesDir, dir = backupsDir(), now = new Date(), tools = pgTools }: MakeOpts): Promise<Backup> {
  await mkdir(dir, { recursive: true });
  const name = backupName(version, now, why);
  const final = path.join(dir, name);
  const part = `${final}.part`;
  const work = await mkdtemp(path.join(os.tmpdir(), "bike-backup-"));
  try {
    const state = await databaseState(adminUrl);
    const manifest: Manifest = { bike: "backup", madeBy: version, why, migrations: state.migrations, madeAt: now.toISOString(), company: state.companies[0] ?? null };
    await writeFile(path.join(work, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await tools.dump(adminUrl, path.join(work, "database.dump"));
    await mkdir(filesDir, { recursive: true });
    await symlink(path.resolve(filesDir), path.join(work, "files"));
    // -h follows the files link, so the archive holds files/… whatever FILES_DIR is.
    await run("tar", ["-ch", "-f", part, "-C", work, "manifest.json", "database.dump", "files"]);
    await rename(part, final);
  } catch (e) {
    await rm(part, { force: true });
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  for (const old of toRemove(await listBackups(dir))) await rm(path.join(dir, old), { force: true });
  return { ...parseName(name)!, bytes: (await stat(final)).size };
}

export async function readManifest(file: string): Promise<Manifest> {
  const { stdout } = await run("tar", ["-xOf", file, "manifest.json"]).catch(() => {
    throw new BackupRefused("This file isn’t one of Bike’s backups.");
  });
  const m = JSON.parse(stdout) as Manifest;
  if (m.bike !== "backup") throw new BackupRefused("This file isn’t one of Bike’s backups.");
  return m;
}

export class BackupRefused extends Error {}

export const HAS_COMPANY = (name: string) =>
  `This Bike already has a company in it (${name}), so nothing was restored. Restore into a new Bike that hasn’t been through first run.`;
export const TOO_NEW = (madeBy: string, version: string) =>
  `This backup was made by Bike ${madeBy}, which has updates to the database this Bike (${version}) doesn’t. Update this Bike to ${madeBy} or later, then restore.`;

export type RestoreOpts = Db & { file: string; filesDir: string; version: string; shipped: number; tools?: PgTools };

// Into a Bike with no company only, and never from a newer Bike. The next start applies any newer updates.
export async function restoreBackup({ adminUrl, file, filesDir, version, shipped, tools = pgTools }: RestoreOpts): Promise<Manifest> {
  await access(file, constants.R_OK).catch(() => {
    throw new BackupRefused(`There is no backup at ${file}.`);
  });
  const manifest = await readManifest(file);
  const state = await databaseState(adminUrl);
  if (state.companies.length) throw new BackupRefused(HAS_COMPANY(state.companies[0]!));
  if (manifest.migrations > shipped) throw new BackupRefused(TOO_NEW(manifest.madeBy, version));
  const work = await mkdtemp(path.join(os.tmpdir(), "bike-restore-"));
  try {
    await run("tar", ["-xf", file, "-C", work]);
    await withSql(adminUrl, (sql) =>
      sql.begin(async (tx) => {
        await tx.unsafe("DROP SCHEMA IF EXISTS pgboss CASCADE");
        await tx.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
        await tx.unsafe("DROP SCHEMA public CASCADE");
        // As Postgres 16 makes it; the backup brings back any rights given on it since.
        await tx.unsafe("CREATE SCHEMA public AUTHORIZATION pg_database_owner");
        await tx.unsafe("GRANT USAGE ON SCHEMA public TO PUBLIC");
      }),
    );
    await tools.restore(adminUrl, path.join(work, "database.dump"));
    await mkdir(filesDir, { recursive: true });
    for (const n of await readdir(filesDir)) await rm(path.join(filesDir, n), { recursive: true, force: true });
    await cp(path.join(work, "files"), filesDir, { recursive: true });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return manifest;
}

// Before the web container applies database updates: a backup when the company's database has updates pending,
// unless update.sh (or a person) made one in the last 10 minutes. A nightly one doesn't count: it isn't of this moment.
export async function backupBeforeUpdate(opts: Omit<MakeOpts, "why"> & { shipped: number }): Promise<Backup | null> {
  const { shipped, ...make } = opts;
  const state = await databaseState(make.adminUrl);
  if (!state.companies.length || state.migrations >= shipped) return null;
  const now = make.now ?? new Date();
  const recent = (await listBackups(make.dir)).find((b) => b.why !== "nightly" && now.getTime() - b.at.getTime() < 10 * 60_000);
  if (recent) return null;
  return makeBackup({ ...make, why: "before-update" });
}

// The worker's hourly look: from 02:00 in the company's time zone, one nightly backup a day (made later if the
// worker was down at 02:00). Nothing before first run.
export async function nightlyBackup(opts: Omit<MakeOpts, "why">): Promise<Backup | null> {
  const state = await databaseState(opts.adminUrl);
  if (!state.companies.length) return null;
  const now = opts.now ?? new Date();
  const tz = state.timeZone ?? "UTC";
  const hour = Number(now.toLocaleString("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }));
  const today = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: tz });
  const last = (await listBackups(opts.dir)).find((b) => b.why === "nightly");
  if (hour < 2 || (last && today(last.at) === today(now))) return null;
  return makeBackup({ ...opts, why: "nightly" });
}
