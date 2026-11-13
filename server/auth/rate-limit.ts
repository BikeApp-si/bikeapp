import { and, eq, gt, lt, count, min } from "drizzle-orm";
import { rateLimitEvents } from "@/db/schema";
import type { Tx } from "@/server/kernel/tx";
import { hashToken } from "./tokens";

export const WINDOW_MS = 15 * 60_000;
export const LIMITS = { email: 5, ip: 20 } as const;

export type Limited = { ok: true } | { ok: false; retryInMinutes: number };

// Trial links (M10b): companies a day from one network address.
export const TRIALS_A_DAY = 3;
const DAY_MS = 24 * 3600_000;

// Sliding window: counts the events for a key in the last 15 minutes (or `windowMs`). Keys are hashed.
async function hit(tx: Tx, key: string, max: number, now: Date, windowMs = WINDOW_MS): Promise<Limited> {
  const since = new Date(now.getTime() - windowMs);
  const k = hashToken(key);
  const [row] = await tx
    .select({ n: count(), first: min(rateLimitEvents.at) })
    .from(rateLimitEvents)
    .where(and(eq(rateLimitEvents.key, k), gt(rateLimitEvents.at, since)));
  if ((row?.n ?? 0) >= max) {
    const first = row?.first ? new Date(row.first) : now;
    const waitMs = first.getTime() + windowMs - now.getTime();
    return { ok: false, retryInMinutes: Math.max(1, Math.ceil(waitMs / 60_000)) };
  }
  await tx.insert(rateLimitEvents).values({ key: k, at: now });
  return { ok: true };
}

// Asking for a code counts against both the email and the IP.
export async function limitCodeRequest(tx: Tx, email: string, ip: string, now: Date): Promise<Limited> {
  const byIp = await hit(tx, `ip:${ip}`, LIMITS.ip, now);
  if (!byIp.ok) return byIp;
  const byEmail = await hit(tx, `email:${email.toLowerCase()}`, LIMITS.email, now);
  if (!byEmail.ok) return byEmail;
  // Old events are no longer needed (kept two days, for the trial companies' daily count).
  await tx.delete(rateLimitEvents).where(lt(rateLimitEvents.at, new Date(now.getTime() - 2 * DAY_MS)));
  return { ok: true };
}

// The pilot form (M10b): at most 5 applications an hour from one network address.
export function limitApplication(tx: Tx, ip: string, now: Date): Promise<Limited> {
  return hit(tx, `apply-ip:${ip}`, 5, now, 3600_000);
}

// A company from a trial link counts against its network address, at most TRIALS_A_DAY in 24 hours.
export function limitTrialCompany(tx: Tx, ip: string, now: Date): Promise<Limited> {
  return hit(tx, `trial-ip:${ip}`, TRIALS_A_DAY, now, DAY_MS);
}
