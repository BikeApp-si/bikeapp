import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditEntries, people, plans } from "@/db/schema";
import { useProvider } from "@/server/ai/gateway";
import type { GuideOutput } from "@/server/ai/prompts/customize-guide@2";
import type { CustomizeOutput } from "@/server/ai/prompts/customize-planner@12";
import type { ProviderRequest } from "@/server/ai/providers/types";
import { seedFernwoodCopy } from "@/seed";
import { fillToSheetLimit } from "@/tests/at-limit";
import { createCapability } from "@/server/kernel/capabilities";
import { readChat } from "@/server/kernel/chats";
import type { KernelCtx } from "@/server/kernel/context";
import { salesLeadsFile } from "@/server/kernel/fixtures";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { sendCustomize, UNSURE, type Via } from "./customize";

// C2: the router, the guide and the buttons, with a scripted model so each answer is known. A guide answer changes
// nothing; only suggestions the kernel would apply become buttons; buttons skip the router; refusals are taught.

type Change = CustomizeOutput["changes"][number];
const blank = { sheet: null, new_sheet: null, column: null, step: null, after: null, rename: null, movers: null, role: null, person: null, rule: null, view: null, labels: null, hint: null, sort: null, check: null, form: null, show_when: null, access: null, link: null, explain: "A change.", part: "A change" };
const change = (c: Partial<Change>): Change => ({ ...blank, kind: "add_column", ...c }) as Change;
const companies = (withOwner: boolean) =>
  change({
    kind: "add_sheet",
    new_sheet: {
      name: "Companies",
      kind: "list",
      parent_sheet: null,
      title_column: "Name",
      row_one: "company",
      row_many: "companies",
      add_action: null,
      columns: [
        { name: "Name", type: "text", required: true, default: null, options: [], link: null, formula: null, result: null },
        ...(withOwner ? [{ name: "Owner", type: "person" as const, required: false, default: { kind: "creator" as const, value: null }, options: [], link: null, formula: null, result: null }] : []),
      ],
      steps: [],
    },
  });
// Hiring is brought to its 6 sheets: a seventh never applies.
const offersSheet = change({ ...companies(false), new_sheet: { ...companies(false).new_sheet!, name: "Offers", row_one: "offer", row_many: "offers" } });
const guide = (o: Partial<GuideOutput>): GuideOutput => ({ answer: "1. Open Customize.\n2. Ask for it.", table: null, section: "Who can see and do what", suggestions: [], cant: false, ...o });

let ws: string;
let wade: KernelCtx;
let script: Record<string, unknown[]> = {};
const sent: ProviderRequest[] = [];
const as = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: ws, personId: wade.actor.id }, (tx) => fn(tx, wade));
const capNamed = (name: string) => as(async (tx) => (await tx.query.capabilities.findFirst({ where: (c, { eq: e }) => e(c.name, name) }))!.id);

beforeAll(async () => {
  ws = (await seedFernwoodCopy(`cg${Date.now().toString(36)}`)).workspaceId;
  await fillToSheetLimit(ws, "Hiring");
  const [u] = await withWorkspace({ workspaceId: ws }, (tx) => tx.select({ id: people.id }).from(people).where(eq(people.email, "wade@fernwood.dev")));
  wade = { workspaceId: ws, actor: { id: u!.id, email: "wade@fernwood.dev" } };
  await as((tx, c) => createCapability(tx, c, salesLeadsFile([u!.id]), { source: "build" }));
  useProvider({
    call: async (req) => {
      sent.push(req);
      const name = req.prompt.split("@")[0]!;
      const next = name === "customize-suggestions" ? { suggestions: [] } : script[name]?.shift();
      if (next === undefined) throw new Error(`No scripted answer for ${req.prompt}`);
      return { model: "claude-haiku-5-5", text: typeof next === "string" ? next : JSON.stringify(next), stop: "done", usage: { tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 }, ms: 1 };
    },
  });
}, 180_000);
afterAll(() => useProvider(null));

const counts = () => as(async (tx) => ({ plans: (await tx.select({ id: plans.id }).from(plans)).length, audit: (await tx.select({ id: auditEntries.id }).from(auditEntries)).length }));

async function say(capName: string, text: string, answers: Record<string, unknown[]>, via: Via = "typed") {
  script = structuredClone(answers);
  sent.length = 0;
  const capId = await capNamed(capName);
  const out = await as((tx, c) => sendCustomize(tx, c, capId, text, via));
  await out.work();
  const reply = (await as((tx, c) => readChat(tx, c, out.chatId))).messages.at(-1)!;
  expect(Object.values(script).flat()).toEqual([]);
  return { reply, prompts: sent.map((r) => r.prompt.split("@")[0]) };
}

describe("a question goes to the guide, which changes nothing", () => {
  it("explains with steps, points at its section, and keeps only suggestions the kernel would apply", async () => {
    const before = await counts();
    const answer = guide({
      suggestions: [
        { label: "Add a Companies sheet with an Owner", changes: [companies(true)] },
        { label: "Let an outsider own companies", changes: [change({ kind: "add_person_to_role", role: "Sales managers", person: "mallory@evil.test" })] },
      ],
    });
    // The suggestion that wouldn't apply goes back for the one retry; still there, it's dropped and the answer stands.
    const r = await say("Sales leads", "How can I add a company sheet? Tell me the steps.", { "customize-router": [{ way: "explain" }], "customize-guide": [answer, answer] });
    expect(r.prompts).toEqual(["customize-router", "customize-guide", "customize-guide"]);
    expect(sent[2]!.retry!.problems).toEqual(["The suggestion “Let an outsider own companies” wouldn't apply: mallory@evil.test isn't in People."]);
    expect(r.reply.status).toBe("done");
    expect(r.reply.text).toBe("1. Open Customize.\n\n2. Ask for it.");
    expect(r.reply.parts).toEqual([
      { kind: "guide", section: "Who can see and do what" },
      { kind: "buttons", buttons: [{ action: "plan", label: "Add a Companies sheet with an Owner" }] },
    ]);
    expect(await counts()).toEqual(before);
  });

  it("drops a section that isn't a heading of the text, and says what Bike can't do", async () => {
    const r = await say("Sales leads", "Can Bike post to Slack when a lead is won?", {
      "customize-router": [{ way: "explain" }],
      "customize-guide": [guide({ answer: "Bike doesn't connect to Slack. The nearest is a rule that emails the owner when a lead is Won.", section: "Slack", cant: true })],
    });
    expect(r.reply.text).toBe("Bike doesn't connect to Slack. The nearest is a rule that emails the owner when a lead is Won.");
    expect(r.reply.parts).toEqual([{ kind: "guide", section: null }]);
  });
});

describe("buttons say where they go", () => {
  it("a suggestion goes straight to the planner, without the router", async () => {
    const r = await say("Sales leads", "Add a Companies sheet with an Owner", { "customize-planner": [{ type: "change", reply: "Here's what changes.", title: "Companies sheet", changes: [companies(true)], clarify: null }] }, "plan");
    expect(r.prompts).toEqual(["customize-planner"]);
    expect(r.reply.parts).toEqual([{ kind: "change", planId: expect.any(String) }]);
  });

  it("a word or two asks Do it or Explain first; Explain first explains the message before", async () => {
    const asked = await say("Sales leads", "Companies?", { "customize-router": [{ way: "unsure" }] });
    expect(asked.reply.text).toBe(UNSURE);
    expect(asked.reply.parts).toEqual([{ kind: "buttons", buttons: [{ action: "do_it", label: "Do it" }, { action: "explain_first", label: "Explain first" }] }]);
    const r = await say("Sales leads", "Explain first", { "customize-guide": [guide({})] }, "explain_first");
    expect(r.prompts).toEqual(["customize-guide"]);
    expect(sent[0]!.message).toContain("Latest message:\nCompanies?");
  });
});

describe("a refusal is taught", () => {
  it("the guide gets the kernel's reason in plain words, and answers with it", async () => {
    const planner = { type: "change", reply: "Here's what changes.", title: "Offers sheet", changes: [offersSheet], clarify: null };
    const r = await say("Hiring", "Add an Offers sheet", {
      "customize-router": [{ way: "change" }],
      "customize-planner": [planner, planner],
      "customize-guide": [guide({ answer: "Hiring already has 6 sheets, the most it can have.", section: null, suggestions: [{ label: "Add Offer amount to Candidates", changes: [change({ kind: "add_column", sheet: "Candidates", column: { name: "Offer amount", type: "money", required: false, default: null, options: [], link: null, formula: null, result: null } })] }] })],
    });
    expect(sent.find((x) => x.prompt.startsWith("customize-guide"))!.message).toContain("Bike couldn't make the change just asked for: Hiring can have at most 6 sheets in this version");
    expect(r.reply.parts).toEqual([{ kind: "guide", section: null, refusal: true }, { kind: "buttons", buttons: [{ action: "plan", label: "Add Offer amount to Candidates" }] }]);
  });

  it("after a refusal, the router is told", async () => {
    await say("Hiring", "Why not?", { "customize-router": [{ way: "explain" }], "customize-guide": [guide({ section: null })] });
    expect(sent[0]!.message).toContain("Bike's last reply said it couldn't make a change.");
  });
});

describe("when the guide can't answer", () => {
  it("a question still gets a plain answer from what Bike knows, never only “I couldn't do that”", async () => {
    const r = await say("Sales leads", "What else could this track?", { "customize-router": [{ way: "explain" }], "customize-guide": ["not json", "not json"] });
    expect(r.reply.status).toBe("done");
    expect(r.reply.text).toMatch(/^I couldn't put a full answer together this time\. Sales leads has one sheet, Leads, and room for 5 more\./);
    expect(r.reply.parts).toEqual([{ kind: "guide", section: null }]);
  });
});
