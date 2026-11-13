import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { capabilities, people } from "@/db/schema";
import { getRow, listRows } from "@/server/kernel/rows";
import { withWorkspace } from "@/server/kernel/tx";
import { waitingFor } from "@/server/kernel/waiting";
import { seedServicesFirm } from "./services-firm";

// G4: the seeded firm adds the professional services set through the kernel; approved time counts toward each
// project's budget at the rate in force on its day.
describe("Kestrel Partners", () => {
  it("adds the set and its rows, and a second run changes nothing", async () => {
    const sub = `firm-${Date.now().toString(36)}`;
    const { workspaceId, created } = await seedServicesFirm(sub);
    expect(created).toBe(true);
    expect((await seedServicesFirm(sub)).created).toBe(false);
    await withWorkspace({ workspaceId }, async (tx) => {
      const apps = await tx.select({ id: capabilities.id, name: capabilities.name }).from(capabilities);
      expect(apps.map((a) => a.name).sort()).toEqual(["Clients and contracts", "Hiring", "Onboarding", "Projects", "Spend", "Time off", "Timesheets"]);
      const ctx = async (user: string) => {
        const [p] = await tx.select({ id: people.id }).from(people).where(eq(people.email, `${user}@kestrel.test`));
        return { workspaceId, actor: { id: p!.id, email: `${user}@kestrel.test` }, now: new Date("2026-10-27T10:00:00+01:00") };
      };
      const projects = apps.find((a) => a.name === "Projects")!.id;
      const rows = await listRows(tx, await ctx("nina"), projects, "projects");
      const spent = Object.fromEntries(rows.map((r) => [r.data.name, [r.data.spent, r.data.remaining]]));
      // Brand refresh: 13 hours of Eva at €85. Ticketing app: 8 of Tim at €95 and 5 of Maja at €90.
      expect(spent).toEqual({ "Brand refresh": [110_500, 2_289_500], "Ticketing app": [121_000, 5_879_000], "Booking site": [772_000, 28_000] });
      const label = (w: { title: string; label: string | null }) => [w.title, w.label];
      expect((await waitingFor(tx, await ctx("marko"))).map(label)).toEqual([["Booking site", "Approve or reject"], ["Brand refresh", "Approve or reject"]]);
      expect((await waitingFor(tx, await ctx("nina"))).map(label)).toEqual([["Print proofs", "Approve or reject"]]);
      expect((await waitingFor(tx, await ctx("ana"))).map(label)).toEqual([["Test phones", "Approve or reject"]]);
      const time = apps.find((a) => a.name === "Timesheets")!.id;
      const jan = await listRows(tx, await ctx("jan"), time, "time");
      expect(new Set(jan.map((r) => r.data.person))).toEqual(new Set([(await ctx("jan")).actor.id]));
      const last = await getRow(tx, await ctx("jan"), jan.find((r) => r.data.date === "2026-10-22")!.id);
      expect([last.data.rate, last.data.value]).toEqual([10_000, 40_000]);
    });
  });
});
