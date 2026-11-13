import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { scannerAnswers } from "@/server/files/scan";
import { edition } from "@/edition";
import { healthText } from "@/server/instance/health";

// /healthz/full, for the uptime monitor (DEPLOY.md): the database and the virus scanner both answer. Fly's own
// check stays on /healthz, so a scanner outage alerts a person but never restarts the app.
// The open Bike's: every item of Settings › Instance with its fix, since a database that's down keeps that page shut.
export async function fullHealth(): Promise<{ status: 200 | 503; body: string }> {
  if (edition.oneCompany()) return healthText();
  const [database, scanner] = await Promise.all([
    db()
      .execute(sql`select 1`)
      .then(() => true)
      .catch(() => false),
    scannerAnswers(),
  ]);
  const down = [database ? null : "database", scanner ? null : "scanner"].filter(Boolean);
  return down.length ? { status: 503, body: `down: ${down.join(", ")}` } : { status: 200, body: "ok" };
}
