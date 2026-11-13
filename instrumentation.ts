import { checkClock } from "@/server/kernel/clock";

// Runs once when the app starts: BIKE_TODAY in production stops it before it serves anything. The open Bike with
// no company yet writes a new setup code to its log (first run, server/kernel/instance.ts).
export async function register() {
  checkClock();
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { edition } = await import("@/edition");
  if (!edition.oneCompany()) return;
  const { ensureSetupCode } = await import("@/server/kernel/instance");
  await ensureSetupCode({ fresh: true }).catch((e: Error) => console.error(`No setup code written yet: ${e.message}`));
}
