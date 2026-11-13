import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { people } from "@/db/schema";
import { seedWorkspace } from "@/seed";
import { seedCapabilities } from "@/seed/capabilities";
import { FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES } from "@/seed/fernwood";
import { REPORT_ASKED, seedHistory } from "@/seed/history";
import type { KernelCtx } from "@/server/kernel/context";
import { runReport } from "@/server/kernel/report/run";
import type { ReportQuery } from "@/server/kernel/report/schema";
import { waitingCounts } from "@/server/kernel/waiting";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { BY_TEAM, CLOUD, ENGINEERING, STARTERS } from "@/seed/history/reports";

// The report history seed gives the numbers screens 11c–11g and 12d show, and nothing on earlier screens
// changes: nobody waits on any of it.

let ws: string;
const ids = new Map<string, string>();
const as = <T>(n: string, fn: (tx: Tx, c: KernelCtx) => Promise<T>) =>
  withWorkspace({ workspaceId: ws, personId: ids.get(n) }, (tx) => fn(tx, { workspaceId: ws, actor: { id: ids.get(n)!, email: `${n}@fernwood.dev` } }));
const run = (q: ReportQuery, asOf = REPORT_ASKED) => as("wade", (tx, c) => runReport(tx, c, q, { asOf }));
let before: Record<string, Record<string, number>>;

beforeAll(async () => {
  ws = (await seedWorkspace({ subdomain: `hi${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
  await seedCapabilities(ws);
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    for (const p of await tx.select({ id: people.id, email: people.email }).from(people)) ids.set(p.email.split("@")[0]!, p.id);
  });
  before = Object.fromEntries(await Promise.all(["priya", "maya", "lena", "wade"].map(async (n) => [n, await as(n, (tx, c) => waitingCounts(tx, c))])));
  await seedHistory(ws);
}, 120_000);

describe("the report history", () => {
  it("11c: Q4 so far by team, as of Oct 26 10:02", async () => {
    const r = await run(BY_TEAM);
    expect(r.rows).toEqual([
      ["Engineering", 60_000, 49_200, 10_800, 82],
      ["Marketing", 25_000, 21_800, 3_200, 87],
      ["Sales", 30_000, 14_100, 15_900, 47],
      ["Operations", 15_000, 6_300, 8_700, 42],
      ["People", 10_000, 3_900, 6_100, 39],
    ]);
    expect(r.sources.find((s) => s.sheet === "Purchases")!.read).toBe(128);
  });

  it("12d: run again on Oct 27, with the 11 that came after", async () => {
    const r = await run(BY_TEAM, new Date("2026-10-27T15:30:00Z"));
    expect(r.rows.map((x) => x[2])).toEqual([52_400, 23_300, 15_000, 7_000, 4_200]);
    expect(r.rows.reduce((n, x) => n + (x[2] as number), 0)).toBe(101_900);
    expect(r.rows[1]![4]).toBe(93);
    expect(r.sources.find((s) => s.sheet === "Purchases")!.read).toBe(139);
  });

  it("11e: Engineering by month since July, against $20,000 a month", async () => {
    const r = await run(ENGINEERING);
    expect(r.rows).toEqual([["2026-07", 18_200, 20_000], ["2026-08", 21_500, 20_000], ["2026-09", 19_800, 20_000], ["2026-10", 49_200, 20_000]]);
    expect(r.sources.find((s) => s.sheet === "Purchases")!.read).toBe(41);
  });

  it("11f: November starters, their first week and their laptop", async () => {
    const r = await run(STARTERS);
    expect(r.rows).toEqual([
      ["Ana Ruiz", "Senior backend engineer", "2026-11-02", "4 of 6 tasks done", "Ordered"],
      ["Leo Grant", "Sales executive", "2026-11-10", "Not started", "No request"],
      ["Mei Chen", "Product designer", "2026-11-16", "1 of 6 tasks done", "Submitted"],
    ]);
  });

  it("11g: cloud by month, only from July 2026", async () => {
    const r = await run(CLOUD);
    expect(r.rows).toEqual([["2026-07", 4_100], ["2026-08", 4_400], ["2026-09", 4_700], ["2026-10", 5_200]]);
    expect(r.sources[0]!.read).toBe(16);
  });

  it("changes nothing anyone waits on", async () => {
    for (const n of ["priya", "maya", "lena", "wade"]) expect(await as(n, (tx, c) => waitingCounts(tx, c))).toEqual(before[n]);
  });
});
