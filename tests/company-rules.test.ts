import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { auditEntries, capabilities, people, ruleRuns, waits } from "@/db/schema";
import { companyRules, saveCompanyRules } from "@/server/kernel/company-rules";
import { createRow } from "@/server/kernel/rows";
import { deleteCapability } from "@/server/kernel/capabilities";
import { runDateRules, systemCtx } from "@/server/kernel/date-rules";
import { currentTime } from "@/server/kernel/clock";
import { waitingFor } from "@/server/kernel/waiting";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import type { KernelCtx } from "@/server/kernel/context";

// Company rules (0.2, M13): one policy applied across capabilities, run by the kernel like each capability's own
// rules; checked when saved (admins only, each part against its capability, no loops); dropped with a deleted
// capability; the same writes give the same result.

const { seedFernwoodCopy } = await import("@/seed");

type Copy = { ws: string; id: Record<"wade" | "lena" | "maya", { id: string; email: string }>; spend: string; contracts: string };

async function copy(prefix: string): Promise<Copy> {
  const ws = (await seedFernwoodCopy(`${prefix}${Date.now().toString(36)}`)).workspaceId;
  return withWorkspace({ workspaceId: ws }, async (tx) => {
    const who = async (n: string) => (await tx.select({ id: people.id, email: people.email }).from(people).where(eq(people.email, `${n}@fernwood.dev`)))[0]!;
    const cap = async (name: string) => (await tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, name)))[0]!.id;
    return { ws, id: { wade: await who("wade"), lena: await who("lena"), maya: await who("maya") }, spend: await cap("Spend"), contracts: await cap("Customer contracts") };
  });
}

const as = <T>(c: Copy, n: keyof Copy["id"], fn: (tx: Tx, ctx: KernelCtx) => Promise<T>, now?: Date) =>
  withWorkspace({ workspaceId: c.ws, personId: c.id[n].id }, (tx) => fn(tx, { workspaceId: c.ws, actor: c.id[n], ...(now ? { now } : {}) }));

// "Expenses and contracts over $10,000 need Lena's approval", on Spend's expenses and Customer contracts.
const bigSpend = (c: Copy) => [
  {
    id: "big_spend",
    text: "Expenses and contracts over $10,000 need Lena's approval.",
    reading: { when: "An expense or a contract over $10,000 is added", then: "It waits on Lena to approve it" },
    enabled: true,
    applications: [
      { id: "expenses", capabilityId: c.spend, trigger: { kind: "row_created", sheet: "expenses" }, condition: { op: "gt", args: [{ col: "amount" }, 1_000_000] }, actions: [{ kind: "ask_person", person: c.id.lena.id, step: "needs_receipt", label: "Approve over $10,000" }] },
      { id: "contracts", capabilityId: c.contracts, trigger: { kind: "row_created", sheet: "contracts" }, condition: { op: "gt", args: [{ col: "value" }, 1_000_000] }, actions: [{ kind: "ask_person", person: c.id.lena.id, step: "draft", label: "Approve over $10,000" }] },
    ],
  },
];

const companyWaits = (c: Copy) =>
  withWorkspace({ workspaceId: c.ws }, (tx) => tx.select({ rowId: waits.rowId, person: waits.personId, rule: waits.ruleId, label: waits.label }).from(waits).where(eq(waits.ruleSource, "company:big_spend")));

describe("a company rule across two capabilities", () => {
  let c: Copy;
  beforeAll(async () => {
    c = await copy("cr");
  }, 120_000);

  it("is saved by an admin as version 1, and asks Lena about a big expense and a big contract, not a small one", async () => {
    expect(await as(c, "wade", (tx, ctx) => saveCompanyRules(tx, ctx, bigSpend(c)))).toEqual({ version: 1 });
    expect((await as(c, "wade", (tx, ctx) => companyRules(tx, ctx))).rules.map((r) => r.id)).toEqual(["big_spend"]);

    const big = await as(c, "maya", (tx, ctx) => createRow(tx, ctx, c.spend, "expenses", { values: { what: "Conference sponsorship", amount: 1_250_000, date: "2026-10-27" } }));
    await as(c, "maya", (tx, ctx) => createRow(tx, ctx, c.spend, "expenses", { values: { what: "Taxi", amount: 5_000, date: "2026-10-27" } }));
    const contract = await as(c, "wade", (tx, ctx) => createRow(tx, ctx, c.contracts, "contracts", { values: { customer: "Big Co", value: 1_500_000 } }));

    const asked = await companyWaits(c);
    expect(asked.map((w) => [w.rowId, w.person, w.rule, w.label]).sort()).toEqual(
      [
        [big.id, c.id.lena.id, "expenses", "Approve over $10,000"],
        [contract.id, c.id.lena.id, "contracts", "Approve over $10,000"],
      ].sort(),
    );
    // Lena's Waiting on me lists the expense, with the company rule's words. The contract waits on her too, but
    // she isn't a contract manager in this Fernwood, and Waiting on me only lists rows a person can see.
    const lena = await as(c, "lena", (tx, ctx) => waitingFor(tx, ctx));
    expect(lena.filter((i) => i.rule === "Expenses and contracts over $10,000 need Lena's approval.").map((i) => i.title)).toEqual(["Conference sponsorship"]);
    // The Audit log: the save (one entry per part, in its capability) and each run.
    const log = await withWorkspace({ workspaceId: c.ws }, (tx) => tx.select().from(auditEntries).where(inArray(auditEntries.event, ["rule.saved", "rule.ran"])));
    expect(log.filter((e) => e.event === "rule.saved" && (e.details as { company?: boolean }).company).map((e) => e.capabilityId).sort()).toEqual([c.spend, c.contracts].sort());
    expect(log.filter((e) => e.event === "rule.ran" && e.who.startsWith("rule:")).length).toBeGreaterThanOrEqual(2);
  });

  it("is admins' only: Maya can't save or read company rules", async () => {
    await expect(as(c, "maya", (tx, ctx) => saveCompanyRules(tx, ctx, bigSpend(c)))).rejects.toThrow("Only admins can do that.");
    await expect(as(c, "maya", (tx, ctx) => companyRules(tx, ctx))).rejects.toThrow("Only admins can do that.");
  });

  it("refuses a part that doesn't fit its capability, and saves nothing", async () => {
    const wrong = bigSpend(c);
    wrong[0]!.applications[0]!.condition = { op: "gt", args: [{ col: "no_such_column" }, 1] };
    await expect(as(c, "wade", (tx, ctx) => saveCompanyRules(tx, ctx, wrong))).rejects.toThrow(/company rule/);
    expect((await as(c, "wade", (tx, ctx) => companyRules(tx, ctx))).version).toBe(1);
  });

  it("refuses a loop through company rules, across capabilities", async () => {
    const loop = [
      {
        id: "ping_pong",
        text: "Each contract starts an expense, and each expense starts a contract.",
        reading: { when: "A contract or an expense is added", then: "The other is started" },
        enabled: true,
        applications: [
          { id: "contracts", capabilityId: c.contracts, trigger: { kind: "row_created", sheet: "contracts" }, actions: [{ kind: "create_row_in", target: { capability: c.spend, sheet: "expenses" }, map: { what: { col: "customer" } } }] },
          { id: "expenses", capabilityId: c.spend, trigger: { kind: "row_created", sheet: "expenses" }, actions: [{ kind: "create_row_in", target: { capability: c.contracts, sheet: "contracts" }, map: { customer: { col: "what" }, value: { col: "amount" } } }] },
        ],
      },
    ];
    await expect(as(c, "wade", (tx, ctx) => saveCompanyRules(tx, ctx, loop))).rejects.toThrow();
    expect((await as(c, "wade", (tx, ctx) => companyRules(tx, ctx))).version).toBe(1);
  });
});

describe("a company date rule", () => {
  it("runs once per row and date, and never for a date before it was saved", async () => {
    const c = await copy("cd");
    const today = currentTime();
    const yesterday = new Date(today.getTime() - 24 * 3600_000);
    const before = await as(c, "wade", (tx, ctx) => createRow(tx, ctx, c.contracts, "contracts", { values: { customer: "Before Co", value: 100_000 } }), yesterday);
    await as(c, "wade", (tx, ctx) =>
      saveCompanyRules(tx, ctx, [
        {
          id: "welcome",
          text: "Tell Lena about each new contract on the day it is added.",
          reading: { when: "The day a contract is added", then: "Lena is told" },
          enabled: true,
          applications: [{ id: "contracts", capabilityId: c.contracts, trigger: { kind: "date_reached", sheet: "contracts", from: "added", offsetDays: 0 }, actions: [{ kind: "notify", people: [c.id.lena.id], message: "A new contract was added." }] }],
        },
      ]),
    );
    const after = await as(c, "wade", (tx, ctx) => createRow(tx, ctx, c.contracts, "contracts", { values: { customer: "After Co", value: 100_000 } }));
    for (let i = 0; i < 2; i++) await withWorkspace({ workspaceId: c.ws }, (tx) => runDateRules(tx, systemCtx(c.ws, currentTime())));
    const runs = await withWorkspace({ workspaceId: c.ws }, (tx) => tx.select({ rowId: ruleRuns.rowId }).from(ruleRuns).where(and(eq(ruleRuns.ruleSource, "company:welcome"), eq(ruleRuns.ruleId, "contracts"))));
    expect(runs.map((r) => r.rowId)).toEqual([after.id]);
    expect(runs.map((r) => r.rowId)).not.toContain(before.id);
  });
});

describe("deleting a capability a company rule applies to", () => {
  it("leaves the rule with its other part, recorded in the Audit log", async () => {
    const c = await copy("cx");
    await as(c, "wade", (tx, ctx) => saveCompanyRules(tx, ctx, bigSpend(c)));
    await as(c, "wade", (tx, ctx) => deleteCapability(tx, ctx, c.contracts, "Customer contracts"));
    const now = await as(c, "wade", (tx, ctx) => companyRules(tx, ctx));
    expect(now.version).toBe(2);
    expect(now.rules[0]!.applications.map((a) => a.id)).toEqual(["expenses"]);
    const removed = await withWorkspace({ workspaceId: c.ws }, (tx) => tx.select().from(auditEntries).where(and(eq(auditEntries.event, "rule.saved"), eq(auditEntries.capabilityId, c.contracts))));
    expect(removed.some((e) => (e.details as { change?: string; company?: boolean }).change === "removed" && (e.details as { company?: boolean }).company)).toBe(true);
  });
});

describe("the same writes give the same result", () => {
  it("two copies with the same company rule and the same rows end up with the same waits and runs", async () => {
    const shape = async (c: Copy) => {
      await as(c, "wade", (tx, ctx) => saveCompanyRules(tx, ctx, bigSpend(c)));
      await as(c, "maya", (tx, ctx) => createRow(tx, ctx, c.spend, "expenses", { values: { what: "Conference sponsorship", amount: 1_250_000, date: "2026-10-27" } }));
      await as(c, "wade", (tx, ctx) => createRow(tx, ctx, c.contracts, "contracts", { values: { customer: "Big Co", value: 1_500_000 } }));
      const ws = await withWorkspace({ workspaceId: c.ws }, (tx) => tx.select({ rule: waits.ruleId, label: waits.label, source: waits.ruleSource }).from(waits).where(eq(waits.ruleSource, "company:big_spend")).orderBy(waits.ruleId));
      const ran = await withWorkspace({ workspaceId: c.ws }, (tx) => tx.select({ event: auditEntries.event, who: auditEntries.who }).from(auditEntries).where(eq(auditEntries.event, "rule.ran")).orderBy(auditEntries.seq));
      return { ws, ran: ran.filter((r) => r.who.startsWith("rule:contracts") || r.who.startsWith("rule:expenses")) };
    };
    const [a, b] = [await shape(await copy("da")), await shape(await copy("db"))];
    expect(a).toEqual(b);
    expect(a.ws).toHaveLength(2);
  });
});
