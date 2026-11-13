import { releaseCheck, saveReleaseCheck } from "@/server/kernel/instance-settings";

// O4: once a day the open Bike's worker asks GitHub for the newest release, and Settings › Instance says when one is
// newer than the running version (docs/design/o4/a-instance-update.png). Nothing about the company is sent: a plain
// request with a plain User-Agent. UPDATE_CHECK=off never asks and shows nothing; a "dev" build has no version to
// compare. GitHub unreachable: nothing is shown and nothing fails.

export const RELEASES = "https://api.github.com/repos/BikeApp-si/bikeapp/releases/latest";
const DAY_MS = 24 * 60 * 60_000;

type Env = Record<string, string | undefined>;
type Version = [number, number, number];

export function parseVersion(v: string | null | undefined): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec((v ?? "").trim());
  return m ? [+m[1]!, +m[2]!, +m[3]!] : null;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

const running = (env: Env) => env.BIKE_VERSION || "dev";
const checking = (env: Env) => env.UPDATE_CHECK?.trim().toLowerCase() !== "off" && parseVersion(running(env)) !== null;

// The newest release on GitHub, or null when it can't be had (offline, an error, no release yet).
export async function latestRelease(get: typeof fetch = fetch): Promise<{ version: string; url: string } | null> {
  try {
    const res = await get(RELEASES, { headers: { "User-Agent": "Bike", Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: string; html_url?: string };
    const v = parseVersion(body.tag_name);
    if (!v || !body.html_url?.startsWith("https://github.com/")) return null;
    return { version: v.join("."), url: body.html_url };
  } catch {
    return null;
  }
}

// The worker's hourly look: asks at most once a day. Returns whether it asked.
export async function checkForRelease({ env = process.env, now = new Date(), get = fetch }: { env?: Env; now?: Date; get?: typeof fetch } = {}): Promise<boolean> {
  if (!checking(env)) return false;
  const last = (await releaseCheck()).checkedAt;
  if (last && now.getTime() - last.getTime() < DAY_MS) return false;
  await saveReleaseCheck(await latestRelease(get), now);
  return true;
}

// What Settings › Instance shows under the version, or null.
export async function newerRelease(env: Env = process.env): Promise<{ version: string; url: string } | null> {
  if (!checking(env)) return null;
  const { version, url } = await releaseCheck();
  return version && url && isNewer(version, running(env)) ? { version, url } : null;
}
