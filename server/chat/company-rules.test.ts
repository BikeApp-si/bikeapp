import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { capabilities, people, waits } from "@/db/schema";
import { seedWorkspace } from "@/seed";
import { seedCapabilities } from "@/seed/capabilities";
import { FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES } from "@/seed/fernwood";
import { COMPANY } from "@/tests/company";
import { addMessage, companyChatFor, plansIn, readChat, saveDraft } from "@/server/kernel/chats";
import { companyRules } from "@/server/kernel/company-rules";
import { createRow, moveStep } from "@/server/kernel/rows";
import { renderCapabilityText } from "@/server/kernel/render-text";
import { load, type KernelCtx } from "@/server/kernel/context";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { applyCompanyFromChat, sendCompanyRules } from "./company-rules";
import type { CompanyDraft } from "./types";

// The Company rules tab's chat (0.2, M14), replaying the answers recorded for tests/company.ts in order: the policy is
// previewed (where it applies, the last 90 days, a warning) and applied, and a big expense then waits on Lena; it is
// changed and applied; a vague message gets a question; it is removed. Maya can't use it, and a stale preview
// can't be applied.

type Who = { id: string; email: string };
let ws: string;
const id: Record<"wade" | "maya" | "lena", Who> = {} as never;
let spend: string;
const as = <T>(who: Who, fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: ws, personId: who.id }, (tx) => fn(tx, { workspaceId: ws, actor: who }));
const k = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => as(id.wade, fn);

async function say(text: string) {
  const out = await k((tx, c) => sendCompanyRules(tx, c, text));
  await out.work();
  const last = (await k((tx, c) => readChat(tx, c, out.chatId))).messages.at(-1)!;
  const plan = (await k((tx, c) => plansIn(tx, c, out.chatId))).at(-1);
  return { chatId: out.chatId, last, plan };
}
async function apply(chatId: string, planId: string) {
  const out = await k((tx, c) => applyCompanyFromChat(tx, c, chatId, planId));
  await out.work();
  return (await k((tx, c) => readChat(tx, c, chatId))).messages.at(-1)!;
}
const lenaWaits = () => withWorkspace({ workspaceId: ws }, (tx) => tx.select({ rowId: waits.rowId }).from(waits).where(and(eq(waits.personId, id.lena.id), like(waits.ruleSource, "company:%"))));

beforeAll(async () => {
  ws = (await seedWorkspace({ subdomain: `cr14${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
  await seedCapabilities(ws);
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    for (const n of ["wade", "maya", "lena"] as const) id[n] = (await tx.select({ id: people.id, email: people.email }).from(people).where(eq(people.email, `${n}@fernwood.dev`)))[0]!;
    spend = (await tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, "Spend")))[0]!.id;
  });
}, 180_000);

describe("the Company rules chat", () => {
  it("previews the policy where it applies, with its last 90 days and a warning, and Apply makes it live", async () => {
    const p = await say(COMPANY.policy);
    expect(p.last.status).toBe("done");
    const d = p.plan!.draft as CompanyDraft;
    expect(d.change).toBe("add");
    expect(d.appliesTo.map((a) => a.where)).toEqual(["Spend · Expenses", "Customer contracts · Contracts"]);
    expect(d.preview.rows.length).toBeGreaterThan(0);
    expect(d.warnings).toEqual([expect.stringContaining("Lena can't see Customer contracts")]);
    // Nothing is live yet.
    expect((await k((tx, c) => companyRules(tx, c))).version).toBe(0);

    const done = await apply(p.chatId, p.plan!.id);
    expect(done.parts.at(-1)).toEqual({ kind: "text", text: "Done. Company rules are at version 1." });
    const now = await k((tx, c) => companyRules(tx, c));
    expect(now.rules.map((r) => r.text)).toEqual([d.text]);

    // A $12,500 expense, submitted, now waits on Lena; Spend's Customize text lists the rule.
    const big = await as(id.maya, (tx, c) => createRow(tx, c, spend, "expenses", { values: { what: "Conference sponsorship", amount: 1_250_000, date: "2026-10-27" } }));
    await as(id.maya, (tx, c) => moveStep(tx, c, big.id, "submitted"));
    expect((await lenaWaits()).map((w) => w.rowId)).toContain(big.id);
    const text = await k(async (tx) => {
      const loaded = await load(tx);
      const files = new Map([...loaded.files].map(([i, f]) => [i, f.file] as const));
      return renderCapabilityText(files.get(spend)!, { capId: spend, files, personName: (i) => loaded.people.get(i)?.name, viewerId: null, company: loaded.company?.rules });
    });
    expect(text.find((s) => s.heading === "Company rules that apply here")?.lines[0]).toBe(d.text);
  });

  it("changes the rule, asks back when the message is vague, and removes it", async () => {
    const c = await say(COMPANY.change);
    const cd = c.plan!.draft as CompanyDraft;
    expect(cd.change).toBe("change");
    expect(JSON.stringify(cd.rules)).toContain("2000000");
    expect((await apply(c.chatId, c.plan!.id)).parts.at(-1)).toEqual({ kind: "text", text: "Done. Company rules are at version 2." });

    const v = await say(COMPANY.vague);
    expect(v.last.parts.some((p) => p.kind === "buttons")).toBe(true);

    const r = await say(COMPANY.remove);
    const rd = r.plan!.draft as CompanyDraft;
    expect(rd.change).toBe("remove");
    expect(rd.button).toBe("Remove this rule");
    expect((await apply(r.chatId, r.plan!.id)).parts.at(-1)).toEqual({ kind: "text", text: "Done. Company rules are at version 3." });
    expect((await k((tx, c) => companyRules(tx, c))).rules).toEqual([]);
  });

  it("refuses a preview the company rules have moved past", async () => {
    const chatId = (await k((tx, c) => companyChatFor(tx, c)))!;
    const stale: CompanyDraft = { kind: "company", version: 1, rules: [], ruleId: null, change: "remove", text: "Old.", reply: "", when: null, then: null, appliesTo: [], preview: { rows: [] }, warnings: [], button: "Remove this rule", collapsed: { lead: "", tail: "" } };
    const plan = await k(async (tx, c) => saveDraft(tx, c, chatId, await addMessage(tx, c, chatId, { from: "bike", text: "" }), stale));
    const done = await apply(chatId, plan.id);
    expect(done.status).toBe("failed");
    expect(JSON.stringify(done.parts)).toContain("The company rules changed since this preview.");
    expect((await k((tx, c) => companyRules(tx, c))).version).toBe(3);
  });

  it("is admins' only: Maya can't write or apply", async () => {
    await expect(as(id.maya, (tx, c) => sendCompanyRules(tx, c, COMPANY.policy))).rejects.toThrow("Only admins can do that.");
    const chatId = (await k((tx, c) => companyChatFor(tx, c)))!;
    const plan = (await k((tx, c) => plansIn(tx, c, chatId))).at(-1)!;
    await expect(as(id.maya, (tx, c) => applyCompanyFromChat(tx, c, chatId, plan.id))).rejects.toThrow();
  });
});
