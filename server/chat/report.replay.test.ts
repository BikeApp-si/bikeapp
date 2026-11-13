import { runQueued } from "@/server/jobs/run";
import "@/server/jobs/runners";
import { beforeAll, describe, expect, it } from "vitest";
import { people } from "@/db/schema";
import { seedWorkspace } from "@/seed";
import { seedCapabilities } from "@/seed/capabilities";
import { FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES } from "@/seed/fernwood";
import { REPORT_ASKED, seedHistory } from "@/seed/history";
import { STEP11 } from "@/seed/history/reports";
import { listChats } from "@/server/kernel/chat-list";
import { readChat } from "@/server/kernel/chats";
import { atInstant } from "@/server/kernel/clock";
import type { KernelCtx } from "@/server/kernel/context";
import { reportsIn } from "@/server/kernel/report/store";
import type { ReportView } from "@/server/kernel/report/view";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { chatView } from "./view";
import { runAgain, send } from "./send";

// Step 11 with the recorded answers of prompt 7 (scripts/ai-record.ts, in the same order): the questions on
// 11a–11g asked Oct 26 at 10:02 give the screens' numbers, which the kernel works out, whatever the model
// named the columns. Run again on the seeded report chat, on Oct 27, gives 12d's. Maya gets no report.

let ws: string;
const ids = new Map<string, string>();
const as = <T>(n: string, fn: (tx: Tx, c: KernelCtx) => Promise<T>) =>
  withWorkspace({ workspaceId: ws, personId: ids.get(n) }, (tx) => fn(tx, { workspaceId: ws, actor: { id: ids.get(n)!, email: `${n}@fernwood.dev` } }));
let seeded: string;

const ask = async (chatId: string | null, text: string) => {
  const out = await atInstant(REPORT_ASKED, async () => {
    const o = await as("wade", (tx, c) => send(tx, c, chatId, text, []));
    await runQueued(ws);
    return o;
  });
  const view = await as("wade", (tx, c) => chatView(tx, c, out.chatId));
  const reply = view.messages.at(-1)!;
  expect(reply.status).toBe("done");
  const part = reply.parts.find((p) => p.kind === "report");
  return { chatId: out.chatId, text: reply.text, report: view.reports[(part as { reportId: string }).reportId]! };
};
// Every number in the CSV, by row: "the screen's numbers are there", whatever the columns are called.
const numbers = (r: ReportView) => r.csv.rows.map((row) => row.filter((c): c is number => typeof c === "number"));

beforeAll(async () => {
  ws = (await seedWorkspace({ subdomain: `rr${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
  await seedCapabilities(ws);
  await seedHistory(ws);
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    for (const p of await tx.select({ id: people.id, email: people.email }).from(people)) ids.set(p.email.split("@")[0]!, p.id);
  });
  seeded = (await as("wade", (tx, c) => listChats(tx, c))).find((c) => c.title === "Spend by team, Q4")!.id;
}, 120_000);

describe("Step 11, recorded", () => {
  let byTeam: string;

  it("11c: spend by team this quarter, against budgets", async () => {
    const r = await ask(null, STEP11.byTeam);
    byTeam = r.chatId;
    expect(r.report.card).toBe("Report · Spend, Tools and budgets · 128 purchases");
    const rows = numbers(r.report);
    expect(rows).toContainEqual(expect.arrayContaining([60_000, 49_200]));
    expect(rows).toContainEqual(expect.arrayContaining([25_000, 21_800]));
    expect(rows).toContainEqual(expect.arrayContaining([140_000, 95_300]));
    expect(r.text).toContain("$95,300");
  });

  it("11e: changed by a reply, Engineering month by month since July", async () => {
    const r = await ask(byTeam, STEP11.engineering);
    expect(r.chatId).toBe(byTeam);
    const spent = numbers(r.report).map((row) => row[0]);
    expect(spent.slice(0, 4)).toEqual([18_200, 21_500, 19_800, 49_200]);
    expect(r.report.chart.kind).not.toBe("none");
  });

  it("11f: November starters, across Hiring, Onboarding and Spend", async () => {
    const r = await ask(null, STEP11.starters);
    // The kernel's facts, in whatever words the model chose for an empty one.
    const line = (name: string) => r.report.csv.rows.map((row) => row.join(" ")).find((l) => l.startsWith(name)) ?? "";
    expect(line("Ana Ruiz")).toMatch(/2026-11-02.*4 of 6.*Ordered/);
    expect(line("Leo Grant")).toMatch(/2026-11-10/);
    expect(line("Leo Grant")).not.toMatch(/of 6|Ordered|Submitted/);
    expect(line("Mei Chen")).toMatch(/2026-11-16.*1 of 6.*Submitted/);
    expect(r.report.print.total).toBeNull();
  });

  it("11g: cloud in 2025 isn't there; from July it is $18,400", async () => {
    const r = await ask(null, STEP11.cloud);
    expect(numbers(r.report).flat()).toEqual(expect.arrayContaining([4_100, 4_400, 4_700, 5_200]));
    expect(r.text).toContain("$18,400");
    expect(r.text).not.toMatch(/^Missing:/);
  });

  it("12d: Run again on the seeded chat, today, beside its first run", async () => {
    const first = (await as("wade", (tx, c) => reportsIn(tx, c, seeded)))[0]!;
    await as("wade", (tx, c) => runAgain(tx, c, seeded, first.id));
    await runQueued(ws);
    const view = await as("wade", (tx, c) => chatView(tx, c, seeded));
    const again = Object.values(view.reports).find((r) => r.firstId === first.id)!;
    expect(again.table.columns).toEqual(["Team", "Budget", "Oct 26", "Oct 27"]);
    expect(again.table.rows).toContainEqual(["Marketing", "$25,000", "$21,800", "$23,300"]);
    expect(again.card).toMatch(/· 139 purchases$/);
    const reply = (await as("wade", (tx, c) => readChat(tx, c, seeded))).messages.at(-1)!;
    expect(reply.text).toMatch(/^Ran again with data to Oct 27/);
    expect(reply.text).toContain("$101,900");
  });

  it("Maya gets no report", async () => {
    await expect(as("maya", (tx, c) => send(tx, c, null, STEP11.byTeam, []))).rejects.toThrow();
    await expect(as("maya", (tx, c) => listChats(tx, c))).rejects.toThrow();
  });
});
