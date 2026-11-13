"use server";

import { asAction } from "@/server/auth/kernel-call";
import { markUpdatesSeen } from "@/server/kernel/inbox";

// Opening Updates: what's shown is no longer new next time.
export async function seenUpdates() {
  return asAction(async (tx, ctx) => {
    await markUpdatesSeen(tx, ctx);
    return {};
  });
}
