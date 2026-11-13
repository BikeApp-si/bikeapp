import { sql } from "drizzle-orm";
import { db, type Db } from "@/db/client";
import { forgetSetup, withSetupCache } from "./setup-cache";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Who is acting, and in which workspace. personId is empty before sign in.
export type Ctx = { workspaceId: string; personId?: string | null };

// Every kernel call runs here: one transaction with the workspace (and person) set for RLS.
export function withWorkspace<T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.workspace_id', ${ctx.workspaceId}, true), set_config('app.person_id', ${ctx.personId ?? ""}, true)`,
    );
    return withSetupCache(() => fn(tx));
  });
}

// The root host (sign up), where no workspace exists yet: only sign ups and their codes are visible.
export function withRoot<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id', '', true), set_config('app.person_id', '', true)`);
    return fn(tx);
  });
}

// One kernel call, all or nothing: a savepoint inside the caller's transaction, so a refused write leaves
// nothing behind even when the caller catches the error and carries on.
export function atomic<T>(tx: Tx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return tx.transaction(fn).catch((e) => {
    // Its writes are undone, so a setup read during them is no longer true.
    forgetSetup();
    throw e;
  });
}
