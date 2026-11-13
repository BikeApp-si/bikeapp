import { runQueued } from "@/server/jobs/run";
import "@/server/jobs/runners";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { capabilities, people } from "@/db/schema";
import { useProvider } from "@/server/ai/gateway";
import type { ProviderRequest } from "@/server/ai/providers/types";
import { seedFernwoodCopy } from "@/seed";
import { BY_TEAM } from "@/seed/history/reports";
import { sendCustomize } from "@/server/chat/customize";
import { send } from "@/server/chat/send";
import { capabilitiesFor } from "@/server/kernel/capabilities";
import type { KernelCtx } from "@/server/kernel/context";
import { checkQuery, visibleFiles } from "@/server/kernel/report/run";
import { withWorkspace, type Tx } from "@/server/kernel/tx";

// Hidden capabilities through chat. On Fernwood, Customer contracts is Wade's and Krishna's (6b): Lena, an
// admin, isn't in its roles. Everything an AI prompt is sent for Lena (plans, reports, Customize) leaves it
// out, its rows included; her report can't name it; she can't customize it. Maya can't chat at all.

let ws: string;
const ids = new Map<string, string>();
const ctx = (n: string): KernelCtx => ({ workspaceId: ws, actor: { id: ids.get(n)!, email: `${n}@fernwood.dev` } });
const as = <T>(n: string, fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: ws, personId: ids.get(n) }, (tx) => fn(tx, ctx(n)));
const sent: ProviderRequest[] = [];
let contracts: string;
// What a prompt sent for Lena must never hold: the capability's name and its customers.
const HIDDEN = ["Customer contracts", "Northwind", "Brightline", "Contract managers"];
// The workspace's part of a request (the fixed instructions carry a generic Customer contracts example).
const payload = (r: ProviderRequest) => JSON.stringify([r.context, r.message]);

beforeAll(async () => {
  ws = (await seedFernwoodCopy(`cx${Date.now().toString(36)}`)).workspaceId;
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    for (const p of await tx.select({ id: people.id, email: people.email }).from(people)) ids.set(p.email.split("@")[0]!, p.id);
    contracts = (await tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, "Customer contracts")))[0]!.id;
  });
  // The stand-in answers with a refusal-free clarifying question, so only what was sent matters.
  useProvider({
    call: async (req) => {
      sent.push(req);
      const text = req.prompt.startsWith("capability-designer")
        ? { type: "clarify", lead: "One question.", brief: null, left_out: null, question: { text: "Which one?", options: ["A", "B"] }, capability: null, rule_requests: [], rules_from: null, suggested_connections: [], also_changes: [], experience: null, flags: [] }
        : { items: [] };
      return { model: "claude-opus-5-5", text: JSON.stringify(text), stop: "done", usage: { tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 }, ms: 1 };
    },
  });
}, 180_000);
afterAll(() => useProvider(null));

describe("what Lena's chats can reach", () => {
  it("Customer contracts isn't one of hers (the premise)", async () => {
    expect((await as("lena", capabilitiesFor)).map((c) => c.name)).not.toContain("Customer contracts");
    expect((await as("wade", capabilitiesFor)).map((c) => c.name)).toContain("Customer contracts");
  });

  it("a plan's prompt, sent for her, says nothing of it", async () => {
    sent.length = 0;
    await as("lena", (tx, c) => send(tx, c, null, "Track our customer contracts and who owns Northwind.", []));
    await runQueued(ws);
    const designer = sent.find((r) => r.prompt.startsWith("capability-designer"))!;
    // Her own words are there; nothing Bike holds about the capability is.
    const without = payload(designer).replaceAll("Track our customer contracts and who owns Northwind.", "");
    for (const s of HIDDEN) expect(without).not.toContain(s);
  });

  it("a report can't name it, and the report prompt's facts leave it out", async () => {
    const q = { ...BY_TEAM, from: [{ capability: "Customer contracts", sheet: "Contracts", as: null }], join: [], where: null, groupBy: [], measures: [{ fn: "count" as const, source: "Contracts", column: null, where: null, as: "Contracts", hidden: false }], computed: [], orderBy: [] };
    expect(checkQuery(q, await as("lena", visibleFiles))).toContain("There is no app “Customer contracts” you can see.");
    expect(checkQuery(q, await as("wade", visibleFiles))).toEqual([]);
  });

  it("she can't customize it", async () => {
    await expect(as("lena", (tx, c) => sendCustomize(tx, c, contracts, "Add a column."))).rejects.toThrow();
  });

  it("Maya can't start a chat at all", async () => {
    await expect(as("maya", (tx, c) => send(tx, c, null, "List every contract.", []))).rejects.toThrow();
  });
});
