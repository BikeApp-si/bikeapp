import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { jobs } from "@/db/schema";
import { kernelWorkspace } from "@/tests/kernel";
import { withWorkspace } from "@/server/kernel/tx";
import { enqueue } from "./queue";
import { failInterrupted, register, runQueued } from "./run";

// The app adds jobs in its own transaction; the worker runs them in order, through the kernel, and marks each
// done or failed. A job the transaction rolled back never runs.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
const ran: string[] = [];
beforeAll(async () => {
  k = await kernelWorkspace();
  register<{ say: string }>("ontology", async (p) => {
    if (p.say === "boom") throw new Error("boom");
    ran.push(p.say);
  });
});

const statuses = () => withWorkspace({ workspaceId: k.workspaceId }, (tx) => tx.select({ status: jobs.status, error: jobs.error, personId: jobs.personId }).from(jobs).orderBy(jobs.createdAt));

describe("jobs", () => {
  it("runs queued jobs oldest first and marks them", async () => {
    await k.as("ada", (tx, c) => enqueue(tx, c, "ontology", { say: "one" }));
    await k.as("ada", (tx, c) => enqueue(tx, c, "ontology", { say: "boom" }));
    await k.as("ada", (tx, c) => enqueue(tx, c, "ontology", { say: "two" }));
    expect(await runQueued(k.workspaceId)).toBe(3);
    expect(ran).toEqual(["one", "two"]);
    const s = await statuses();
    expect(s.map((j) => j.status)).toEqual(["done", "failed", "done"]);
    expect(s[1]!.error).toBe("boom");
    expect(s[0]!.personId).toBe(k.id.ada);
    expect(await runQueued(k.workspaceId)).toBe(0);
  });

  it("never runs a job whose transaction was rolled back", async () => {
    await k.as("ada", async (tx, c) => {
      await enqueue(tx, c, "ontology", { say: "never" });
      throw new Error("rolled back");
    }).catch(() => {});
    expect(await runQueued(k.workspaceId)).toBe(0);
    expect(ran).not.toContain("never");
  });

  it("marks jobs a stopped worker left running as failed", async () => {
    const id = await k.as("ada", (tx, c) => enqueue(tx, c, "ontology", { say: "left" }));
    await withWorkspace({ workspaceId: k.workspaceId }, (tx) => tx.update(jobs).set({ status: "running" }).where(eq(jobs.id, id)));
    await failInterrupted(k.workspaceId);
    const [j] = await withWorkspace({ workspaceId: k.workspaceId }, (tx) => tx.select().from(jobs).where(eq(jobs.id, id)));
    expect(j!.status).toBe("failed");
  });
});
