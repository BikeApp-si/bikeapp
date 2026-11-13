import { describe, expect, it } from "vitest";
import { desc } from "drizzle-orm";
import { auditEntries } from "@/db/schema";
import { withWorkspace } from "@/server/kernel/tx";
import { freshWorkspace } from "@/tests/helpers";
import { createSession, endSession, personForSession } from "./session";

describe("endSession (Log out)", () => {
  it("ends this workspace's session only and writes auth.signout", async () => {
    const a = await freshWorkspace();
    const b = await freshWorkspace();
    const tokenA = await withWorkspace(a, (tx) => createSession(tx, a));
    const tokenB = await withWorkspace(b, (tx) => createSession(tx, b));

    await endSession(a.workspaceId, tokenA);
    expect(await personForSession(a.workspaceId, tokenA)).toBeNull();
    expect(await personForSession(b.workspaceId, tokenB)).not.toBeNull();
    // A token from another workspace ends nothing there.
    await endSession(a.workspaceId, tokenB);
    expect(await personForSession(b.workspaceId, tokenB)).not.toBeNull();

    const [last] = await withWorkspace(a, (tx) => tx.select().from(auditEntries).orderBy(desc(auditEntries.seq)).limit(1));
    expect(last).toMatchObject({ who: a.email, event: "auth.signout" });
  });
});
