// The worker process: pnpm worker. pg-boss keeps its own tables in the "pgboss" schema, on the owner's
// connection, for the timed jobs; the jobs the app adds (queue.ts) wake it through a notify. Every job runs
// through the kernel as the app (bike_app), like any request.
import postgres from "postgres";
import { PgBoss } from "pg-boss";
import { checkClock } from "@/server/kernel/clock";
import { edition } from "@/edition";
import { filesDir } from "@/server/files/storage";
import { nightlyBackup } from "@/server/instance/backup";
import { checkForRelease } from "@/server/instance/updates";
import { direct } from "@/db/urls";
import { failInterrupted, runQueued, workspaceIds } from "./run";
import { sendOutbox, tick } from "./tick";
import "./runners";

try { process.loadEnvFile(); } catch {}
checkClock();

const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error("Set DATABASE_ADMIN_URL in .env");
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL in .env");

// No index rebuilds: a managed database (Fly) doesn't let us, and job tables stay small. pg-boss still checks
// for bloat once a day; there it can't read pg_statistic, which is noted in one line, not as a failure.
const boss = new PgBoss({ connectionString: direct(url), schema: "pgboss", reindex: false });
boss.on("error", (e) => (/pg_statistic/.test(e.message) ? console.log("pg-boss: index bloat check not allowed on this database (fine)") : console.error(e)));
await boss.start();

// The open Bike's own: each hour, the nightly backup once it is past 02:00 in the company's time zone, and the
// daily look for a newer release (docs/install.md; UPDATE_CHECK=off never looks).
const ownBike = edition.oneCompany()
  ? ([
      ["backup", "5 * * * *", async () => void (await nightlyBackup({ adminUrl: direct(url), version: process.env.BIKE_VERSION || "dev", filesDir: filesDir() }))],
      ["release", "15 * * * *", async () => void (await checkForRelease())],
    ] as const)
  : [];

for (const [name, cron, run] of [
  ["tick", "0 * * * *", () => tick()],
  ["outbox", "* * * * *", () => sendOutbox()],
  ...ownBike,
] as const) {
  await boss.createQueue(name);
  await boss.schedule(name, cron);
  await boss.work(name, async () => {
    await run();
  });
}

// Up to this many jobs at once in one workspace, so a long build doesn't hold up a plan someone else asks for.
const PER_WORKSPACE = 3;
const running = new Map<string, number>();

function drain(workspaceId: string) {
  const n = running.get(workspaceId) ?? 0;
  if (n >= PER_WORKSPACE) return;
  running.set(workspaceId, n + 1);
  runQueued(workspaceId)
    .catch((e) => console.error(`Jobs in ${workspaceId}:`, e))
    .finally(() => running.set(workspaceId, (running.get(workspaceId) ?? 1) - 1));
}

for (const id of await workspaceIds()) await failInterrupted(id);
// LISTEN needs a direct connection, never through a transaction pooler.
const listener = postgres(direct(process.env.DATABASE_URL), { max: 1, onnotice: () => {} });
await listener.listen("bike_jobs", (workspaceId) => drain(workspaceId));
// A notify can be missed (a restart, a dropped connection): every few seconds each workspace is checked too.
const sweep = async () => {
  for (const id of await workspaceIds().catch(() => [])) drain(id);
};
setInterval(sweep, 5_000);
await sweep();
console.log(`Worker started: jobs as they come, date rules and morning emails hourly, the outbox every minute${ownBike.length ? ", the nightly backup and the look for a newer release" : ""}`);
