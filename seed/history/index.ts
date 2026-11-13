import { and, eq } from "drizzle-orm";
import { capabilities, people, rows } from "@/db/schema";
import type { KernelCtx } from "@/server/kernel/context";
import { importRows, updateRow, type NewRow } from "@/server/kernel/rows";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { seedReportChats } from "./chats";

// The report history (M8): the rows the report screens add up, in their own part so the earlier screens
// stay as they are. Everything comes in as history (an import that starts no rules), so nobody waits on any
// of it, and no bubble, morning email or opening changes. The numbers are the screens':
//   11c  Q4 so far by team, as of Oct 26 10:02: Budget $140,000, Spent $95,300, 128 purchases
//   11e  Engineering by month: Jul $18,200, Aug $21,500, Sep $19,800, Oct $49,200 (41 purchases)
//   11f  November starters: Ana (Nov 2), Leo (Nov 10), Mei (Nov 16), their onboarding and laptops
//   11g  Cloud expenses: Jul $4,100, Aug $4,400, Sep $4,700, Oct 1–26 $5,200 (16 expenses)
//   12d  After Oct 26 10:02, 11 more purchases: $101,900 and 139 purchases when run again
// Then Wade's three report chats (chats.ts), each with its first run.

const IMPORTED = new Date("2026-10-12T10:00:00Z"); // after Spend and Tools and budgets were set up
export const REPORT_ASKED = new Date("2026-10-26T15:02:00Z"); // 12c: Oct 26, 10:02 in Chicago

type Team = "engineering" | "marketing" | "sales" | "operations" | "people";
const ASKER: Record<Team, string[]> = {
  engineering: ["priya", "maya", "omar"],
  marketing: ["nina", "dev"],
  sales: ["rita", "dev"],
  operations: ["krishna", "jon"],
  people: ["aisha"],
};
const SUPPLIERS: Record<Team, string[]> = {
  engineering: ["AWS", "JetBrains", "GitHub", "Apple", "Datadog", "Linear"],
  marketing: ["Google Ads", "LinkedIn", "Canva", "Vimeo", "Printful"],
  sales: ["Salesforce", "Gong", "Apollo", "Delta", "Hilton"],
  operations: ["Staples", "WeWork", "FedEx", "Dell"],
  people: ["Lattice", "Greenhouse", "Eventbrite"],
};
const ITEMS: Record<Team, string[]> = {
  engineering: ["Cloud hosting", "IDE licenses", "CI minutes", "Test devices", "Monitoring", "Issue tracker seats"],
  marketing: ["Search ads", "Sponsored posts", "Design seats", "Video hosting", "Event swag"],
  sales: ["CRM seats", "Call recording", "Prospect data", "Client travel", "Hotel"],
  operations: ["Office supplies", "Meeting rooms", "Shipping", "Monitors"],
  people: ["Review software", "Job posts", "Team event"],
};

// n whole-dollar amounts adding up to total exactly, varied but the same every run.
function split(total: number, n: number, salt: number): number[] {
  const weights = Array.from({ length: n }, (_, i) => 3 + ((i * 7 + salt * 5) % 9));
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((w) => Math.max(10, Math.round((total * w) / sum / 10) * 10));
  out[n - 1] = total - out.slice(0, -1).reduce((a, b) => a + b, 0);
  return out;
}

const day = (month: number, d: number) => `2026-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const COUNTED = ["approved", "ordered", "received"] as const;

type Purchase = { what: string; team: Team; by: string; date: string; supplier: string; status: string; dollars: number };

// A team's purchases in a month: n of them adding up to total, on days up to lastDay, at counted steps.
function month(team: Team, m: number, total: number, n: number, lastDay: number): Purchase[] {
  return split(total, n, m + team.length).map((dollars, i) => ({
    what: `${ITEMS[team][i % ITEMS[team].length]}`,
    team,
    by: ASKER[team][i % ASKER[team].length]!,
    date: day(m, 1 + ((i * 5 + m) % lastDay)),
    supplier: SUPPLIERS[team][i % SUPPLIERS[team].length]!,
    status: COUNTED[(i + m) % 3]!,
    dollars,
  }));
}

export const PURCHASES: Purchase[] = [
  // Engineering, 11e: 41 purchases Jul–Oct.
  ...month("engineering", 7, 18_200, 9, 28),
  ...month("engineering", 8, 21_500, 10, 28),
  ...month("engineering", 9, 19_800, 9, 28),
  // October: 3 yearly licenses ($24,600), Ana's laptop, and 9 more.
  ...[1, 2, 3].map((i) => ({ what: `Yearly license ${i === 1 ? "(JetBrains)" : i === 2 ? "(GitHub)" : "(Datadog)"}`, team: "engineering" as Team, by: "priya", date: day(10, 2 + i * 4), supplier: ["JetBrains", "GitHub", "Datadog"][i - 1]!, status: "approved", dollars: 8_200 })),
  { what: "Laptop for Ana Ruiz", team: "engineering", by: "priya", date: day(10, 19), supplier: "Apple", status: "ordered", dollars: 2_400 },
  ...month("engineering", 10, 22_200, 9, 26),
  // The other teams' October, 11c: 115 more, 128 in all.
  ...month("marketing", 10, 21_800, 38, 26),
  ...month("sales", 10, 14_100, 34, 26),
  ...month("operations", 10, 6_300, 25, 26),
  ...month("people", 10, 3_900, 18, 26),
  // Their summer, which no screen shows by itself.
  ...[7, 8, 9].flatMap((m) => [month("marketing", m, 6_000, 6, 28), month("sales", m, 8_000, 6, 28), month("operations", m, 4_000, 5, 28), month("people", m, 2_500, 4, 28)].flat()),
  // Left out of 11c: 6 rejected in October, and Mei's laptop still waiting.
  ...([["marketing", 1_200], ["marketing", 640], ["sales", 2_300], ["sales", 410], ["engineering", 3_100], ["operations", 520]] as const).map(([team, dollars], i) => ({
    what: `${ITEMS[team][i % ITEMS[team].length]} (duplicate)`,
    team,
    by: ASKER[team][0]!,
    date: day(10, 4 + i * 3),
    supplier: SUPPLIERS[team][0]!,
    status: "rejected",
    dollars,
  })),
  { what: "Laptop for Mei Chen", team: "engineering", by: "wade", date: day(10, 22), supplier: "Apple", status: "submitted", dollars: 2_400 },
];

// 12d: what came in after the report was first run. $6,600 more, 11 purchases.
export const LATER: Purchase[] = (
  [
    ["engineering", 3_200, 3],
    ["marketing", 1_500, 2],
    ["sales", 900, 2],
    ["operations", 700, 2],
    ["people", 300, 2],
  ] as const
).flatMap(([team, total, n]) => split(total, n, 4).map((dollars, i) => ({ what: ITEMS[team][(i + 2) % ITEMS[team].length]!, team, by: ASKER[team][0]!, date: day(10, 26 + (i % 2)), supplier: SUPPLIERS[team][i]!, status: "approved", dollars })));

const BUDGETS: [Team, string, number][] = [
  ["engineering", "Q3", 60_000], ["marketing", "Q3", 24_000], ["sales", "Q3", 30_000], ["operations", "Q3", 15_000], ["people", "Q3", 9_000],
  ["engineering", "Q4", 60_000], ["marketing", "Q4", 25_000], ["sales", "Q4", 30_000], ["operations", "Q4", 15_000], ["people", "Q4", 10_000],
];

// 11g: the cloud bills, 4 a month.
const CLOUD: [number, number, number][] = [
  [7, 4_100, 28],
  [8, 4_400, 28],
  [9, 4_700, 28],
  [10, 5_200, 24],
];
const CLOUD_VENDORS = ["AWS", "Google Cloud", "Datadog", "Vercel"];

export async function seedHistory(workspaceId: string) {
  const wade = await withWorkspace({ workspaceId }, async (tx) => {
    const ids = new Map((await tx.select({ id: people.id, email: people.email }).from(people)).map((p) => [p.email.split("@")[0]!, p.id]));
    const wade = ids.get("wade")!;
    const ctx = (at: Date): KernelCtx => ({ workspaceId, actor: { id: wade, email: "wade@fernwood.dev" }, now: at });
    const cap = async (name: string) => (await tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, name)))[0]!.id;
    const history = (capId: string, sheet: string, list: NewRow[], source: string, at = IMPORTED) => importRows(tx, ctx(at), capId, sheet, list, { source, at, history: true });

    const spend = await cap("Spend");
    const purchases = async (list: Purchase[], at: Date) => {
      const made = await history(
        spend,
        "purchases",
        list.map((p) => ({ values: { what: p.what, team: p.team, requested_by: ids.get(p.by), date: p.date, supplier: p.supplier, status: p.status } })),
        "purchases.csv",
        at,
      );
      await history(spend, "purchase_lines", list.map((p, i) => ({ values: { item: p.what, quantity: 1, unit_price: p.dollars * 100 }, parentRowId: made[i] })), "purchases.csv", at);
    };
    await purchases(PURCHASES, IMPORTED);
    await purchases(LATER.slice(0, 6), new Date("2026-10-26T19:30:00Z"));
    await purchases(LATER.slice(6), new Date("2026-10-27T14:10:00Z"));

    await history(
      spend,
      "expenses",
      CLOUD.flatMap(([m, total, last]) =>
        split(total, 4, m).map((dollars, i) => ({
          values: { what: `${CLOUD_VENDORS[i]}, ${["July", "August", "September", "October"][m - 7]}`, who: ids.get("priya"), date: day(m, Math.min(last, 3 + i * 7)), amount: dollars * 100, category: "cloud", paid_with: "company_card", status: "paid", paid_on: day(m, Math.min(last + 2, 28)) },
        })),
      ),
      "expenses.csv",
    );

    const tools = await cap("Tools and budgets");
    await history(tools, "budgets", BUDGETS.map(([team, quarter, dollars]) => ({ values: { team, quarter, budget: dollars * 100 } })), "budgets.csv");

    // 11f: Ana's candidate row (hired before Bike), Mei's start date, Mei's first week.
    const hiring = await cap("Hiring");
    const rowsOf = (capId: string, sheet: string) => tx.select({ id: rows.id, data: rows.data }).from(rows).where(and(eq(rows.capabilityId, capId), eq(rows.sheetId, sheet)));
    // Her own filled opening, Wade's: not one of Priya's, so 8d's 9 candidates stay 9.
    const [opening] = await history(hiring, "openings", [{ values: { role: "Senior backend engineer", team: "engineering", hiring_manager: wade, opens_on: "2026-05-01", status: "filled" } }], "candidates.csv");
    await history(hiring, "candidates", [{ values: { name: "Ana Ruiz", opening, source: "referral", stage: "hired", start_date: "2026-11-02" } }], "candidates.csv");
    const mei = (await rowsOf(hiring, "candidates")).find((r) => (r.data as { name?: string }).name === "Mei Chen")!;
    await updateRow(tx, ctx(IMPORTED), mei.id, { start_date: "2026-11-16" });

    const onboarding = await cap("Onboarding");
    const [plan] = await history(onboarding, "plans", [{ values: { name: "Mei Chen", start_date: "2026-11-16", manager: wade, buddy: ids.get("omar"), it: ids.get("jon") } }], "plans.csv");
    const TASKS = ["Laptop and accounts", "Design tools", "Meet the team", "First design review", "Product walkthrough", "30-day check-in"];
    await history(onboarding, "tasks", TASKS.map((task, i) => ({ values: { plan, task, owner: i === 0 ? ids.get("jon") : wade, due: day(11, 16 + i), status: i === 2 ? "done" : "to_do" } })), "tasks.csv");
    return wade;
  });
  // Wade's report chats (12a–12c), as Wade: chats are seen only by their author.
  await withWorkspace({ workspaceId, personId: wade }, (tx) => seedReportChats(tx, { workspaceId, actor: { id: wade, email: "wade@fernwood.dev" } }));
}

// For tests: what the screens add up, from the seed's own lists.
export const totals = (list: Purchase[], team: Team, from: string, to: string) =>
  list.filter((p) => p.team === team && p.date >= from && p.date <= to && (COUNTED as readonly string[]).includes(p.status)).reduce((n, p) => n + p.dollars, 0);
export type { Tx };
