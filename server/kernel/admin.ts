import { eq } from "drizzle-orm";
import { people } from "@/db/schema";
import { AccessError, type KernelCtx } from "./context";
import type { Tx } from "./tx";

// Admin-only kernel calls (Settings, People, the Audit log, deleting a capability) start here.
export async function mustBeAdmin(tx: Tx, ctx: KernelCtx) {
  const [me] = await tx.select({ isAdmin: people.isAdmin }).from(people).where(eq(people.id, ctx.actor.id));
  if (!me?.isAdmin) throw new AccessError("Only admins can do that.");
}
