import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { people } from "@/db/schema";
import { useProvider } from "@/server/ai/gateway";
import type { CustomizeOutput } from "@/server/ai/prompts/customize-planner@12";
import type { ProviderRequest } from "@/server/ai/providers/types";
import { seedFernwoodCopy } from "@/seed";
import { fillToSheetLimit } from "@/tests/at-limit";
import { createCapability } from "@/server/kernel/capabilities";
import { plansIn, readChat } from "@/server/kernel/chats";
import type { KernelCtx } from "@/server/kernel/context";
import { salesLeadsFile } from "@/server/kernel/fixtures";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { sendCustomize } from "./customize";
import type { CustomizeDraft } from "./types";

// C1: the kernel's problems go into prompt 3's retry, a question's choices are checked before they're offered,
// and a refusal is never said twice the same way. With a scripted model, so each answer is known.

type Change = CustomizeOutput["changes"][number];
const blank = { sheet: null, new_sheet: null, column: null, step: null, after: null, rename: null, movers: null, role: null, person: null, rule: null, view: null, labels: null, hint: null, sort: null, check: null, form: null, show_when: null, access: null, link: null, explain: "A change.", part: "A change" };
const change = (c: Partial<Change>): Change => ({ ...blank, kind: "add_column", ...c }) as Change;
const sheet = (name: string, columns: { name: string; type: "text" | "person"; creator?: boolean }[]) =>
  change({
    kind: "add_sheet",
    new_sheet: {
      name,
      kind: "list",
      parent_sheet: null,
      title_column: columns[0]!.name,
      row_one: name.toLowerCase().replace(/s$/, ""),
      row_many: name.toLowerCase(),
      add_action: null,
      columns: columns.map((c) => ({ name: c.name, type: c.type, required: false, default: c.creator ? { kind: "creator", value: null } : null, options: [], link: null, formula: null, result: null })),
      steps: [],
    },
  });
const offers = sheet("Offers", [{ name: "Candidate", type: "text" }]);
const offerAmount = change({ kind: "add_column", sheet: "Candidates", column: { name: "Offer amount", type: "money", required: false, default: null, options: [], link: null, formula: null, result: null } });
const answer = (o: Partial<CustomizeOutput>): CustomizeOutput => ({ type: "change", reply: "Here's what changes.", title: "A small change", changes: [], clarify: null, ...o });

let ws: string;
let wade: KernelCtx;
let queue: CustomizeOutput[] = [];
const sent: ProviderRequest[] = [];
const as = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: ws, personId: wade.actor.id }, (tx) => fn(tx, wade));
const capNamed = (name: string) => as(async (tx) => (await tx.query.capabilities.findFirst({ where: (c, { eq: e }) => e(c.name, name) }))!.id);

beforeAll(async () => {
  ws = (await seedFernwoodCopy(`cr${Date.now().toString(36)}`)).workspaceId;
  const [u] = await withWorkspace({ workspaceId: ws }, (tx) => tx.select({ id: people.id }).from(people).where(eq(people.email, "wade@fernwood.dev")));
  wade = { workspaceId: ws, actor: { id: u!.id, email: "wade@fernwood.dev" } };
  await as((tx, c) => createCapability(tx, c, salesLeadsFile([u!.id]), { source: "build" }));
  useProvider({
    call: async (req) => {
      sent.push(req);
      // C2: the router sends these to the planner; the guide gives nothing usable, so C1's plain refusals stay.
      const next = req.prompt.startsWith("customize-planner") ? queue.shift() : req.prompt.startsWith("customize-router") ? { way: "change" } : req.prompt.startsWith("customize-guide") ? "not json" : { suggestions: [] };
      if (!next) throw new Error(`No scripted answer for ${req.prompt}`);
      return { model: "claude-opus-5-5", text: typeof next === "string" ? next : JSON.stringify(next), stop: "done", usage: { tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 }, ms: 1 };
    },
  });
}, 180_000);
afterAll(() => useProvider(null));

async function say(capId: string, text: string, answers: CustomizeOutput[]) {
  queue = [...answers];
  sent.length = 0;
  const out = await as((tx, c) => sendCustomize(tx, c, capId, text));
  await out.work();
  const reply = (await as((tx, c) => readChat(tx, c, out.chatId))).messages.at(-1)!;
  expect(queue).toEqual([]);
  return { chatId: out.chatId, reply, planner: sent.filter((r) => r.prompt === "customize-planner@12") };
}

describe("Hiring, already at 6 sheets", () => {
  let hiring: string;
  beforeAll(async () => {
    await fillToSheetLimit(ws, "Hiring");
    hiring = await capNamed("Hiring");
  });

  it("the retry gets the kernel's own problem; after it, the admin reads it in plain words", async () => {
    const r = await say(hiring, "Add an Offers sheet", [answer({ title: "Offers sheet", changes: [offers] }), answer({ title: "Offers sheet", changes: [offers] })]);
    expect(r.planner[1]!.retry!.problems).toEqual(["Hiring: at most 6 sheets; put the rest under Later."]);
    expect(r.reply.status).toBe("done");
    expect(r.reply.text).toBe("I can't apply that. Hiring can have at most 6 sheets in this version, and this would make more.");
  });

  it("the same refusal again becomes a question, and a choice that wouldn't apply goes back to the AI first", async () => {
    const bad = answer({ type: "clarify", title: null, reply: "Hiring has all the sheets it can have. What would help most?", clarify: { question: "Which?", options: [{ label: "Add Offers anyway", changes: [offers] }, { label: "Add Offer amount to Candidates", changes: [offerAmount] }], hint: null } });
    const good = answer({ ...bad, clarify: { question: "Which?", options: [{ label: "Add Offer amount to Candidates", changes: [offerAmount] }, { label: "Add Offer date to Candidates", changes: [change({ ...offerAmount, column: { ...offerAmount.column!, name: "Offer date", type: "date" } })] }], hint: null } });
    const r = await say(hiring, "Add an Offers sheet", [answer({ title: "Offers sheet", changes: [offers] }), answer({ title: "Offers sheet", changes: [offers] }), bad, good]);
    expect(r.planner[2]!.message).toContain("Bike has already answered this with: \"I can't apply that. Hiring can have at most 6 sheets");
    expect(r.planner[3]!.retry!.problems).toEqual(["The choice “Add Offers anyway” wouldn't apply: Hiring: at most 6 sheets; put the rest under Later."]);
    expect(r.reply.parts[0]).toEqual({ kind: "buttons", buttons: [{ action: "plan", label: "Add Offer amount to Candidates" }, { action: "plan", label: "Add Offer date to Candidates" }] });
    // A question saves nothing.
    expect(await as((tx, c) => plansIn(tx, c, r.chatId)).then((p) => p.filter((x) => x.status === "waiting"))).toEqual([]);
  });

  it("a title of five words is let through; one too long goes back naming it and its length", async () => {
    const five = await say(hiring, "Add offer amount and date", [answer({ title: "Offer amount and offer date", changes: [offerAmount] })]);
    expect(five.planner).toHaveLength(1);
    expect(five.reply.status).toBe("done");
    const r = await say(hiring, "Add offer amount and date", [answer({ title: "The amount and the date of the offer", changes: [offerAmount] }), answer({ title: "Offer details", changes: [offerAmount] })]);
    expect(r.planner[1]!.retry!.problems).toEqual([
      "title: “The amount and the date of the offer” is 8 words; it must be two to four, naming the main thing it adds or changes (“Legal review step”, “Earlier renewal reminders”), even when there are several changes.",
    ]);
    expect(r.reply.status).toBe("done");
  });
});

describe("Sales leads, where Lead owners see their own leads", () => {
  it("a Companies sheet with an Owner previews with what Lead owners will see", async () => {
    const cap = await capNamed("Sales leads");
    const r = await say(cap, "Add a Companies sheet", [answer({ title: "Companies sheet", changes: [sheet("Companies", [{ name: "Name", type: "text" }, { name: "Owner", type: "person", creator: true }])] })]);
    expect(r.planner).toHaveLength(1);
    expect(r.reply.parts).toEqual([{ kind: "change", planId: expect.any(String) }]);
    const [p] = await as((tx, c) => plansIn(tx, c, r.chatId));
    expect((p!.draft as CustomizeDraft).impact).toBe("Lead owners see their own companies, by Owner.");
    // The prompt reads how each role sees each sheet today.
    expect(r.planner[0]!.context).toContain('"Leads": "their own rows, by Owner"');
  });
});
