import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditEntries, people, plans } from "@/db/schema";
import { useProvider } from "@/server/ai/gateway";
import type { AdvisorOutput } from "@/server/ai/prompts/customize-advisor@2";
import type { CustomizeOutput } from "@/server/ai/prompts/customize-planner@12";
import type { ProviderRequest } from "@/server/ai/providers/types";
import { seedFernwoodCopy } from "@/seed";
import { fillToSheetLimit } from "@/tests/at-limit";
import { readChat, type Message } from "@/server/kernel/chats";
import type { KernelCtx } from "@/server/kernel/context";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { sendCustomize } from "./customize";

// C3: the advisor with a scripted model, so each answer is known. Only items the kernel would apply become buttons,
// never more new sheets than there's room for; a failed advisor falls back to the guide; advice saves nothing.

type Change = CustomizeOutput["changes"][number];
type Item = AdvisorOutput["groups"][number]["items"][number];
const blank = { sheet: null, new_sheet: null, column: null, step: null, after: null, rename: null, movers: null, role: null, person: null, rule: null, view: null, labels: null, hint: null, sort: null, check: null, form: null, show_when: null, access: null, link: null, explain: "A change.", part: "A change" };
const col = (name: string) => ({ name, type: "text" as const, required: false, default: null, options: [], link: null, formula: null, result: null });
const sheet = (name: string): Change => ({ ...blank, kind: "add_sheet", new_sheet: { name, kind: "list", parent_sheet: null, title_column: "Name", row_one: name.toLowerCase(), row_many: name.toLowerCase(), add_action: null, columns: [col("Name")], steps: [] } }) as Change;
const column = (on: string, name: string): Change => ({ ...blank, kind: "add_column", sheet: on, column: col(name) }) as Change;
const item = (title: string, place: Item["place"], changes: Change[] = [], request: string | null = place === "view" || place === "not_yet" ? null : `Do ${title}`): Item => ({ title, why: `Why ${title}.`, fields: ["Name (text)"], place, request, changes });
const advice = (items: Item[]): AdvisorOutput => ({ intro: "Here's what would help.", groups: [{ title: "Start with these", items }], start: "Start with the first." });

let ws: string;
let wade: KernelCtx;
let script: Record<string, unknown[]> = {};
const sent: ProviderRequest[] = [];
const as = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: ws, personId: wade.actor.id }, (tx) => fn(tx, wade));
const capNamed = (name: string) => as(async (tx) => (await tx.query.capabilities.findFirst({ where: (c, { eq: e }) => e(c.name, name) }))!.id);
const counts = () => as(async (tx) => ({ plans: (await tx.select({ id: plans.id }).from(plans)).length, audit: (await tx.select({ id: auditEntries.id }).from(auditEntries)).length }));

beforeAll(async () => {
  ws = (await seedFernwoodCopy(`ca${Date.now().toString(36)}`)).workspaceId;
  await fillToSheetLimit(ws, "Hiring");
  const [u] = await withWorkspace({ workspaceId: ws }, (tx) => tx.select({ id: people.id }).from(people).where(eq(people.email, "wade@fernwood.dev")));
  wade = { workspaceId: ws, actor: { id: u!.id, email: "wade@fernwood.dev" } };
  useProvider({
    call: async (req) => {
      sent.push(req);
      const next = script[req.prompt.split("@")[0]!]?.shift();
      if (next === undefined) throw new Error(`No scripted answer for ${req.prompt}`);
      return { model: "claude-sonnet-5-5", text: typeof next === "string" ? next : JSON.stringify(next), stop: "done", usage: { tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 }, ms: 1 };
    },
  });
}, 180_000);
afterAll(() => useProvider(null));

async function say(capName: string, text: string, answers: Record<string, unknown[]>) {
  script = structuredClone(answers);
  sent.length = 0;
  const out = await as(async (tx, c) => sendCustomize(tx, c, await capNamed(capName), text));
  await out.work();
  const reply = (await as((tx, c) => readChat(tx, c, out.chatId))).messages.at(-1)!;
  expect(Object.values(script).flat()).toEqual([]);
  return { reply, prompts: sent.map((r) => r.prompt.split("@")[0]) };
}
const buttons = (m: Message) => m.parts.flatMap((p) => (p.kind === "buttons" ? p.buttons.map((b) => b.label) : []));

describe("the kernel keeps advice honest", () => {
  it("Hiring is at its 6 sheets: a new sheet there goes back for the retry and is never a button; a column that applies is", async () => {
    const answer = advice([item("Offers", "here", [sheet("Offers")]), item("Rejection reason", "here", [column("Candidates", "Rejection reason")]), item("Time to hire", "report")]);
    const before = await counts();
    const r = await say("Hiring", "What else should we track?", { "customize-router": [{ way: "advise" }], "customize-advisor": [answer, answer] });
    expect(r.prompts).toEqual(["customize-router", "customize-advisor", "customize-advisor"]);
    expect(sent[2]!.retry!.problems).toContain("“Offers” adds a sheet, but there's room for only 0 more here: place it as its own app.");
    expect(r.reply.status).toBe("done");
    expect(buttons(r.reply)).toEqual(["Do Rejection reason"]);
    expect(r.reply.parts.find((p) => p.kind === "link")).toEqual({ kind: "link", label: "Ask for Time to hire in Home", href: "/home?ask=Do%20Time%20to%20hire", outline: true });
    // Advice changes nothing.
    expect(await counts()).toEqual(before);
  });

  it("a name that doesn't exist is never a button", async () => {
    const answer = advice([item("Notes on a sheet that isn't there", "here", [column("Invoices", "Notes")]), item("Monthly view", "view")]);
    const r = await say("Hiring", "How can this be better?", { "customize-router": [{ way: "advise" }], "customize-advisor": [answer, answer] });
    expect(buttons(r.reply)).toEqual([]);
    expect(r.reply.parts[0]).toMatchObject({ kind: "advice" });
  });

  it("when the advisor fails, the guide answers", async () => {
    const r = await say("Hiring", "What am I missing?", {
      "customize-router": [{ way: "advise" }],
      "customize-advisor": ["not json", "not json"],
      "customize-guide": [{ answer: "Hiring covers openings, candidates and interviews.", table: null, section: null, suggestions: [], cant: false }],
    });
    expect(r.prompts).toEqual(["customize-router", "customize-advisor", "customize-advisor", "customize-guide"]);
    expect(r.reply.parts).toEqual([{ kind: "guide", section: null }]);
  });
});
