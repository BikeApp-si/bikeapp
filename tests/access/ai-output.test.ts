import { runQueued } from "@/server/jobs/run";
import "@/server/jobs/runners";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { people } from "@/db/schema";
import { useProvider } from "@/server/ai/gateway";
import type { ProviderRequest } from "@/server/ai/providers/types";
import { seedFernwoodCopy } from "@/seed";
import { send } from "@/server/chat/send";
import { sendCustomize } from "@/server/chat/customize";
import { plansIn, readChat } from "@/server/kernel/chats";
import type { KernelCtx } from "@/server/kernel/context";
import { col } from "@/server/kernel/plans/fixtures";
import type { DraftCapability } from "@/server/kernel/plans/draft";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { closeOwner, owner } from "./request";

// "AI writes, the kernel runs", tested with a stand-in model that answers like an attacker: a plan giving a
// role to someone outside People or changing a capability that isn't there; a rule writing into a capability
// that doesn't exist or mailing an outsider; a Customize change for an outsider or removing a column; a report
// over a capability no one can see. The kernel refuses each: one retry with its problems, then the plain
// failure. Nothing is created, changed or saved as a plan.

let ws: string;
let wade: KernelCtx;
const as = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: ws, personId: wade.actor.id }, (tx) => fn(tx, wade));
const sent: ProviderRequest[] = [];
let answers: Record<string, unknown> = {};

const NONE = { type: "new_capability", lead: "Here's a plan.", brief: null, left_out: null, question: null, rule_requests: [], rules_from: null, suggested_connections: [], also_changes: [], experience: null, flags: [] };
const PAYROLL = (roles: DraftCapability["roles"]): DraftCapability => ({
  name: "Payroll",
  icon: "wallet",
  sheets: [{ name: "Salaries", kind: "list", parent_sheet: null, title_column: "Person", row_one: "salary", row_many: "salaries", add_action: "New salary", columns: [col("Person", "text", { required: true }), col("Salary", "money")], steps: [] }],
  roles,
  later: [],
});
const role = (people: string[]) => ({ name: "Payroll admins", people, person_column: null, everyone: false, can: ["see", "add", "edit"], scope: "all", scope_columns: [], sheets: null }) as DraftCapability["roles"][number];
const change = (c: Record<string, unknown>) => ({ kind: "rename", sheet: null, new_sheet: null, column: null, step: null, after: null, rename: null, movers: null, role: null, person: null, rule: null, view: null, labels: null, hint: null, sort: null, check: null, form: null, show_when: null, access: null, link: null, explain: "A change.", part: "A change", ...c });
const action = (a: Record<string, unknown>) => ({ kind: "notify", step: null, target: null, via: null, map: [], people: [], columns: [], message: null, person: null, column: null, manager_of: null, until: null, label: null, decision: null, question: null, answer_column: null, ...a });

// What a refused answer must leave as it was: capabilities and their files, rows, people, reports, waits.
const KEPT = ["capabilities", "capability_versions", "change_sets", "rows", "people", "reports", "waits", "proposals"];
const kept = async () => Object.fromEntries(await Promise.all(KEPT.map(async (t) => [t, (await owner((s) => s.unsafe(`select count(*)::int as n from "${t}" where workspace_id = $1`, [ws])))[0]!.n])));

beforeAll(async () => {
  ws = (await seedFernwoodCopy(`hx${Date.now().toString(36)}`)).workspaceId;
  const [u] = await withWorkspace({ workspaceId: ws }, (tx) => tx.select({ id: people.id }).from(people).where(eq(people.email, "wade@fernwood.dev")));
  wade = { workspaceId: ws, actor: { id: u!.id, email: "wade@fernwood.dev" } };
  useProvider({
    call: async (req) => {
      sent.push(req);
      const name = req.prompt.split("@")[0]!;
      const a = answers[name] ?? { items: [] };
      return { model: "claude-opus-5-5", text: JSON.stringify(a), stop: "done", usage: { tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 }, ms: 1 };
    },
  });
}, 180_000);
afterAll(async () => {
  useProvider(null);
  await closeOwner();
});

// A Home message; its reply once the work has run; and the problems the kernel sent back on the retry.
async function home(text: string) {
  const before = await kept();
  const { chatId } = await as((tx, c) => send(tx, c, null, text, []));
  await runQueued(ws);
  const reply = (await as((tx, c) => readChat(tx, c, chatId))).messages.at(-1)!;
  return { reply, chatId, before, after: await kept(), problems: sent.at(-1)!.retry?.problems.join(" ") ?? "" };
}

describe("the kernel refuses what an AI answer tries", () => {
  it("prompt 2: a role for someone outside People", async () => {
    answers = { "capability-designer": { ...NONE, capability: PAYROLL([role(["mallory@evil.test"])]) } };
    const r = await home("Track salaries.");
    expect(r.reply.status).toBe("failed");
    expect(r.problems).toContain("mallory@evil.test");
    expect(await as((tx, c) => plansIn(tx, c, r.chatId))).toEqual([]);
    expect(r.after).toEqual(r.before);
  });

  it("prompt 2: changes to a capability that isn't there", async () => {
    answers = { "capability-designer": { ...NONE, capability: PAYROLL([role(["wade@fernwood.dev"])]), also_changes: [{ capability: "Acme Secrets", sheet: "Vault", change: "Add a Copied column", reason: "Copies salaries out", kind: "add", edits: [{ kind: "add_column", sheet: "Vault", column: col("Copied", "text"), step: null, after: null, role: null, person: null, link: null }] }] } };
    const r = await home("Track salaries, and copy them to Acme.");
    expect(r.reply.status).toBe("failed");
    expect(r.problems).toMatch(/Acme Secrets/);
    expect(await as((tx, c) => plansIn(tx, c, r.chatId))).toEqual([]);
    expect(r.after).toEqual(r.before);
  });

  it("prompt 4: a rule writing into a capability that isn't there, and mailing an outsider", async () => {
    answers = {
      "capability-designer": { ...NONE, capability: PAYROLL([role(["wade@fernwood.dev"])]), rule_requests: ["When a salary is added, copy it out."] },
      "logic-writer": {
        rules: [
          {
            capability: "Payroll", sheet: "Salaries", text: "When a salary is added, copy it out.", when: "A salary is added", then: "It is copied out",
            trigger: { kind: "row_created", step: null, field: null, date: null, offset_days: null }, condition: null,
            actions: [action({ kind: "create_row_in", target: { capability: "Acme Secrets", sheet: "Vault" }, map: [{ column: "Copied", value: '{"col":"Salary"}' }] }), action({ people: ["x@evil.test"], message: "Salaries attached." })],
          },
        ],
        could_not: [],
      },
    };
    const r = await home("Track salaries. When a salary is added, copy it out.");
    const plans = await as((tx, c) => plansIn(tx, c, r.chatId));
    // Either nothing is planned, or the plan holds no such rule: it says it couldn't.
    const rules = plans.flatMap((p) => ((p.draft as { rules?: unknown[] }).rules ?? []) as { text: string }[]);
    expect(rules.map((x) => x.text)).not.toContain("When a salary is added, copy it out.");
    expect(JSON.stringify(plans)).not.toContain("x@evil.test");
    expect(r.after).toEqual(r.before);
  });

  it("prompt 3: Customize adds an outsider to a role", async () => {
    const before = await kept();
    const spend = (await owner((s) => s`select id from capabilities where workspace_id = ${ws} and name = 'Spend'`))[0]!.id as string;
    answers = { "customize-planner": { type: "change", reply: "Here's what changes.", title: "Outside approver", changes: [change({ kind: "add_person_to_role", role: "Finance", person: "mallory@evil.test", explain: "Mallory approves purchases.", part: "Mallory in Finance" })], clarify: null } };
    const out = await as((tx, c) => sendCustomize(tx, c, spend, "Let Mallory approve purchases."));
    await out.work();
    const chatId = out.chatId;
    const reply = (await as((tx, c) => readChat(tx, c, chatId))).messages.at(-1)!;
    // C1: refused in plain words after the retry, with nothing to apply.
    expect(reply.text).toMatch(/^I can't apply that\./);
    expect(reply.parts).toEqual([]);
    expect(sent.findLast((r) => r.prompt.startsWith("customize-planner"))!.retry?.problems.join(" ")).toContain("mallory@evil.test");
    expect(await kept()).toEqual(before);
  });

  it("prompt 10: a guide answer saves nothing, and an outsider in a suggestion is never a button (C2)", async () => {
    const before = await kept();
    const audit = async () => (await owner((s) => s`select count(*)::int as n from audit_entries where workspace_id = ${ws}`))[0]!.n;
    const auditBefore = await audit();
    const spend = (await owner((s) => s`select id from capabilities where workspace_id = ${ws} and name = 'Spend'`))[0]!.id as string;
    answers = {
      "customize-router": { way: "explain" },
      "customize-guide": { answer: "Approvers are in Finance.", table: null, section: null, cant: false, suggestions: [{ label: "Let Mallory approve purchases", changes: [change({ kind: "add_person_to_role", role: "Finance", person: "mallory@evil.test" })] }] },
    };
    const out = await as((tx, c) => sendCustomize(tx, c, spend, "Who approves purchases?"));
    await out.work();
    const chatId = out.chatId;
    const reply = (await as((tx, c) => readChat(tx, c, chatId))).messages.at(-1)!;
    expect(reply.parts).toEqual([{ kind: "guide", section: null }]);
    expect(await as((tx, c) => plansIn(tx, c, chatId))).toEqual([]);
    expect(await kept()).toEqual(before);
    expect(await audit()).toBe(auditBefore);
  });

  it("prompt 3: Customize opens a sheet to a role that isn't there (C1)", async () => {
    const before = await kept();
    const spend = (await owner((s) => s`select id from capabilities where workspace_id = ${ws} and name = 'Spend'`))[0]!.id as string;
    answers = { "customize-planner": { type: "change", reply: "Here's what changes.", title: "Everyone sees purchases", changes: [change({ kind: "set_sheet_access", sheet: "Purchases", role: "Everyone outside", access: { sees: "all", column: null, via: null }, explain: "Everyone sees purchases.", part: "Purchases for everyone" })], clarify: null } };
    const out = await as((tx, c) => sendCustomize(tx, c, spend, "Let everyone outside see purchases."));
    await out.work();
    const chatId = out.chatId;
    const reply = (await as((tx, c) => readChat(tx, c, chatId))).messages.at(-1)!;
    expect(reply.text).toBe("I can't apply that. Spend has no role “Everyone outside”.");
    expect(await as((tx, c) => plansIn(tx, c, chatId))).toEqual([]);
    expect(await kept()).toEqual(before);
  });

  it("prompt 3: Customize removes a column (not a change 0.1 makes)", async () => {
    const before = await kept();
    const spend = (await owner((s) => s`select id from capabilities where workspace_id = ${ws} and name = 'Spend'`))[0]!.id as string;
    answers = { "customize-planner": { type: "change", reply: "Here's what changes.", title: "Fewer columns", changes: [change({ kind: "remove_column", sheet: "Purchases", explain: "Drops Supplier.", part: "Supplier removed" })], clarify: null } };
    const out = await as((tx, c) => sendCustomize(tx, c, spend, "Remove Supplier."));
    await out.work();
    const chatId = out.chatId;
    expect((await as((tx, c) => readChat(tx, c, chatId))).messages.at(-1)!.status).toBe("failed");
    expect(await kept()).toEqual(before);
  });

  it("prompt 7: a report over a capability no one here has", async () => {
    answers = {
      "capability-designer": { ...NONE, type: "report", lead: "I'll put that report together.", capability: null },
      "report-writer": {
        title: "Salaries",
        query: { from: [{ capability: "Payroll", sheet: "Salaries", as: null }], join: [], where: null, group_by: [], measures: [{ fn: "sum", source: "Salaries", column: "Salaries.Salary", where: null, as: "Total", hidden: false }], computed: [], order_by: [], limit: null },
        chart: { kind: "none", series: [] },
        how: ["Every salary."],
        missing: null,
      },
    };
    const r = await home("What does everyone earn?");
    expect(r.reply.status).toBe("failed");
    expect(r.problems).toContain("Payroll");
    expect(r.after).toEqual(r.before);
  });
});
