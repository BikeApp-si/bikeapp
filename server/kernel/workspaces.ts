import { edition } from "@/edition";
import { forgetSetup } from "./setup-cache";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { workspaces, people } from "@/db/schema";
import { checkAddress, shortName } from "@/lib/address";
import { db } from "@/db/client";
import { record } from "./audit";
import { withWorkspace } from "./tx";
import { currentTime } from "./clock";

export class AddressError extends Error {}

export type Workspace = { id: string; name: string; shortName: string; timeZone: string; subdomain: string };

// The only cross-workspace read: address → workspace (a SECURITY DEFINER function).
export async function workspaceBySubdomain(subdomain: string): Promise<Workspace | null> {
  const rows = await db().execute<{ id: string; name: string; short_name: string; time_zone: string }>(
    sql`select * from workspace_by_subdomain(${subdomain})`,
  );
  const w = rows[0];
  return w ? { id: w.id, name: w.name, shortName: w.short_name, timeZone: w.time_zone, subdomain } : null;
}

export async function addressAvailable(subdomain: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const check = checkAddress(subdomain);
  if (!check.ok) return check;
  const rows = await db().execute<{ taken: boolean }>(sql`select subdomain_taken(${subdomain}) as taken`);
  return rows[0]?.taken ? { ok: false, reason: "That address is taken." } : { ok: true };
}

export type NewWorkspace = {
  subdomain: string;
  name: string;
  timeZone: string;
  admin: { name: string; email: string; title?: string | null; team?: string | null; startDate?: string | null };
  at?: Date; // now when left out; the seed sets the time the screens show
  setupDone?: boolean; // the seed's workspaces skip setup 2b–2g
  trial?: string | null; // the trial link's label it was created from (M10b)
  paid?: boolean; // P1 (hosted): a new company starts on Business with its 30-day free trial; the seed's companies are paid
};

// 2a Continue: checks the address again and creates the workspace with its first admin, in one transaction.
export async function createWorkspace(input: NewWorkspace) {
  const available = await addressAvailable(input.subdomain);
  if (!available.ok) throw new AddressError(available.reason);
  const ctx = { workspaceId: randomUUID() };
  try {
    return await withWorkspace(ctx, async (tx) => {
      await tx.insert(workspaces).values({
        id: ctx.workspaceId,
        subdomain: input.subdomain,
        name: input.name.trim(),
        shortName: shortName(input.name),
        timeZone: input.timeZone,
        trial: input.trial ?? null,
        plan: "business",
        planStartedAt: input.at ?? currentTime(),
        ...(input.paid ? { paidAt: input.at ?? currentTime() } : { trialEndsAt: edition.trialEndsAt(input.at ?? currentTime()) }),
        createdAt: input.at ?? currentTime(),
        ...(input.setupDone ? { setupDoneAt: input.at ?? currentTime() } : {}),
      });
      const [admin] = await tx
        .insert(people)
        .values({
          workspaceId: ctx.workspaceId,
          name: input.admin.name.trim(),
          email: input.admin.email.toLowerCase(),
          title: input.admin.title ?? null,
          team: input.admin.team ?? null,
          startDate: input.admin.startDate ?? null,
          isAdmin: true,
        })
        .returning({ id: people.id });
      forgetSetup();
      await tx.update(workspaces).set({ ownerId: admin!.id }).where(eq(workspaces.id, ctx.workspaceId));
      forgetSetup();
      await record(tx, ctx, {
        who: input.admin.email.toLowerCase(),
        event: "workspace.created",
        details: { name: input.name.trim(), address: input.subdomain, timeZone: input.timeZone, ...(input.trial ? { trialLink: input.trial } : {}) },
        at: input.at,
      });
      return { workspaceId: ctx.workspaceId, personId: admin!.id };
    });
  } catch (e) {
    // Two people picked the same address at once: the unique index decides.
    if (e instanceof Error && /workspaces_subdomain_unique|duplicate key/.test(String((e as { cause?: unknown }).cause ?? e.message)))
      throw new AddressError("That address is taken.");
    throw e;
  }
}
