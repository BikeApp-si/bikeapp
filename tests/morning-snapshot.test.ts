import { beforeAll, describe, expect, it } from "vitest";
import { people } from "@/db/schema";
import { startWork } from "@/server/kernel/context";
import { systemCtx } from "@/server/kernel/date-rules";
import { currentTime } from "@/server/kernel/clock";
import { withWorkspace } from "@/server/kernel/tx";
import { waitingFor, waitingForEveryone, waitingForOne } from "@/server/kernel/waiting";
import { unprime } from "@/server/kernel/access";

// The morning emails read what waits on everyone once (M12). For every person, that must give exactly their own
// Waiting on me: the same items, in the same order.
const { seedFernwoodCopy } = await import("@/seed");
let ws: string;
beforeAll(async () => {
  ws = (await seedFernwoodCopy(`ms${Date.now().toString(36)}`)).workspaceId;
}, 120_000);

describe("what waits on everyone, read once", () => {
  it("gives each person exactly their own Waiting on me", async () => {
    const everyone = await withWorkspace({ workspaceId: ws }, (tx) => tx.select({ id: people.id, email: people.email }).from(people));
    const own = new Map<string, unknown>();
    for (const p of everyone) own.set(p.id, await withWorkspace({ workspaceId: ws, personId: p.id }, (tx) => waitingFor(tx, { workspaceId: ws, actor: p })));
    const shared = await withWorkspace({ workspaceId: ws }, async (tx) => {
      const w = await startWork(tx, systemCtx(ws, currentTime()));
      const snapshot = await waitingForEveryone(w);
      const out = new Map<string, unknown>();
      for (const p of everyone) out.set(p.id, await waitingForOne(w, p.id, snapshot));
      unprime(w.loaded);
      return out;
    });
    for (const p of everyone) expect(shared.get(p.id), p.email).toEqual(own.get(p.id));
    // And it isn't empty: Priya's three.
    expect((own.get(everyone.find((p) => p.email === "priya@fernwood.dev")!.id) as unknown[]).length).toBe(3);
  });
});
