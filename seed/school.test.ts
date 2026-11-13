import { describe, expect, it } from "vitest";
import { capabilities } from "@/db/schema";
import { withWorkspace } from "@/server/kernel/tx";
import { listRows } from "@/server/kernel/rows";
import { waitingFor } from "@/server/kernel/waiting";
import { people } from "@/db/schema";
import { eq } from "drizzle-orm";
import { seedSchool } from "./school";

// G3: the seeded school adds the CBSE set through the kernel, and its fee cards come from the set's company rule.
describe("Greenfield Public School", () => {
  it("adds the set and its rows, and a second run changes nothing", async () => {
    const sub = `school-${Date.now().toString(36)}`;
    const { workspaceId, created } = await seedSchool(sub);
    expect(created).toBe(true);
    expect((await seedSchool(sub)).created).toBe(false);
    await withWorkspace({ workspaceId }, async (tx) => {
      const apps = await tx.select({ id: capabilities.id, name: capabilities.name }).from(capabilities);
      expect(apps.map((a) => a.name).sort()).toEqual(["Admissions", "Attendance", "Classes and students", "Exams and report cards", "Fees", "Staff leave"]);
      const [sunita] = await tx.select({ id: people.id }).from(people).where(eq(people.email, "sunita@greenfield.test"));
      const ctx = { workspaceId, actor: { id: sunita!.id, email: "sunita@greenfield.test" }, now: new Date("2026-10-27T10:00:00+05:30") };
      const fees = apps.find((a) => a.name === "Fees")!.id;
      const cards = await listRows(tx, ctx, fees, "cards");
      expect(cards.map((c) => [c.data.year_fee, c.data.owing])).toEqual([[5_400_000, 4_050_000], [5_400_000, 5_400_000], [5_400_000, 5_400_000]]);
      const [rahul] = await tx.select({ id: people.id }).from(people).where(eq(people.email, "rahul@greenfield.test"));
      expect(await waitingFor(tx, { workspaceId, actor: { id: rahul!.id, email: "rahul@greenfield.test" }, now: ctx.now })).toEqual([]);
    });
  });
});
