import { describe, expect, it } from "vitest";
import { freshWorkspace } from "@/tests/helpers";
import { load } from "./context";
import { addPerson } from "./directory";
import { atomic, withWorkspace } from "./tx";

// The setup is read once per request (M12), and never stale: a change in the same request is seen at once, and
// one undone by a failed savepoint is forgotten.
describe("the setup read once per request", () => {
  it("is shared by the kernel calls of one request", async () => {
    const { workspaceId, personId } = await freshWorkspace();
    await withWorkspace({ workspaceId, personId }, async (tx) => {
      expect(await load(tx)).toBe(await load(tx));
    });
  });

  it("shows a change to People made in the same request, and forgets one that was undone", async () => {
    const { workspaceId, personId, email } = await freshWorkspace();
    const ctx = { workspaceId, actor: { id: personId, email } };
    await withWorkspace({ workspaceId, personId }, async (tx) => {
      const before = (await load(tx)).people.size;
      await addPerson(tx, ctx, { name: "Nora New", email: `nora${Date.now()}@cache.test`, title: null, team: null, managerEmail: null } as never);
      expect((await load(tx)).people.size).toBe(before + 1);

      await expect(
        atomic(tx, async (t) => {
          await addPerson(t, ctx, { name: "Una Undone", email: `una${Date.now()}@cache.test`, title: null, team: null, managerEmail: null } as never);
          expect((await load(t)).people.size).toBe(before + 2);
          throw new Error("undo");
        }),
      ).rejects.toThrow("undo");
      expect((await load(tx)).people.size).toBe(before + 1);
    });
  });
});
