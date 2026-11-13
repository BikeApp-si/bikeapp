import { runQueued } from "@/server/jobs/run";
import "@/server/jobs/runners";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { auditEntries, chats, people } from "@/db/schema";
import { useProvider } from "@/server/ai/gateway";
import type { ProviderRequest } from "@/server/ai/providers/types";
import { seedWorkspace } from "@/seed";
import { FERNWOOD_ADMIN } from "@/seed/fernwood";
import { plansIn, readChat, type Part } from "@/server/kernel/chats";
import type { KernelCtx } from "@/server/kernel/context";
import { PACK_PLAN } from "@/server/kernel/plans/fixtures";
import { saveUpload } from "@/server/kernel/uploads";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import type { BuildDraft } from "./build-read";
import { send } from "./send";

// 4a–4b on a Fernwood with only its founder: the pack in one message, prompt 2 says it needs several
// capabilities, the chat becomes a build, the files are read and prompt 1's plan is checked and shown. A
// reply plans again. The AI answers come from a stand-in provider; the kernel's side is real.

let ws: string;
let wade: { id: string; email: string };
const as = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: ws, personId: wade.id }, (tx) => fn(tx, { workspaceId: ws, actor: wade }));

const DESIGN_BUILD = { type: "build", lead: "This needs several capabilities.", brief: null, left_out: null, question: null, capability: null, rule_requests: [], rules_from: null, suggested_connections: [], also_changes: [], experience: null, flags: [] };
const sent: ProviderRequest[] = [];
let plannerAnswers: unknown[] = [];

beforeAll(async () => {
  ws = (await seedWorkspace({ subdomain: `bd${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, [])).workspaceId;
  const [u] = await withWorkspace({ workspaceId: ws }, (tx) => tx.select({ id: people.id, email: people.email }).from(people));
  wade = u!;
  useProvider({
    call: async (req) => {
      sent.push(req);
      const answer = req.prompt === "capability-designer@11" ? DESIGN_BUILD : plannerAnswers.shift();
      return { model: "claude-opus-5-5", text: JSON.stringify(answer), stop: "done", usage: { tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 }, ms: 1 };
    },
  });
});
afterAll(() => useProvider(null));

const upload = (name: string) => as((tx, c) => saveUpload(tx, c, { name, body: new Uint8Array(readFileSync(`tests/files/pack/${name}`)) }));
const lastReply = async (chatId: string) => (await as((tx, c) => readChat(tx, c, chatId))).messages.at(-1)!;
const tableOf = (parts: Part[]) => parts.find((p) => p.kind === "table") as Extract<Part, { kind: "table" }>;

describe("a build from documents (4a–4b)", () => {
  let chatId: string;

  it("turns the pack into a build and shows the plan", async () => {
    // The first answer names a file that isn't there: the kernel sends it back once with the problem.
    plannerAnswers = [{ ...PACK_PLAN, people: { ...PACK_PLAN.people, file: "staff.csv" } }, PACK_PLAN];
    const ids: string[] = [];
    for (const n of ["How Fernwood runs.docx", "Fernwood policies.pdf", "zoho-export.zip"]) ids.push((await upload(n)).id);
    chatId = (await as((tx, c) => send(tx, c, null, "This is how we run, our policies, and an export from our old ERP. Set Bike up from these.", ids))).chatId;
    await runQueued(ws);

    // Prompt 2 saw the Word and PDF text and each table's header, not its rows.
    const design = sent.find((r) => r.prompt === "capability-designer@11")!;
    expect(design.message).toContain("Lena Ortiz owns our tools list");
    expect(design.message).toContain('<table file="employees.csv" in="zoho-export.zip" rows="14">');
    expect(design.message).not.toContain("priya@fernwood.dev,Engineering lead");

    const planner = sent.filter((r) => r.prompt === "workspace-planner@2");
    expect(planner).toHaveLength(2);
    expect(planner[0]!.message).toContain('"file":"contracts.csv","column":"Account Owner"');
    expect(planner[1]!.retry?.problems.join(" ")).toContain('"staff.csv" isn\'t one of the tables');

    const reply = await lastReply(chatId);
    expect(reply.status).toBe("done");
    expect(tableOf(reply.parts).rows.map((r) => r[1])).toEqual(["People", "Hiring", "Onboarding", "Tools and budgets", "Spend", "Time off", "Customer contracts"]);
    expect(reply.parts.at(-1)).toEqual({ kind: "buttons", buttons: [{ action: "build", label: "Build all", primary: true }] });

    const [chat] = await as((tx) => tx.select().from(chats).where(eq(chats.id, chatId)));
    expect(chat!.kind).toBe("build");
    expect(chat!.title).toBe("Fernwood Labs from the brief");
    const [plan] = await as((tx, c) => plansIn(tx, c, chatId));
    const draft = plan!.draft as BuildDraft;
    expect(draft.files.map((f) => f.uploadId)).toEqual(ids);
    expect(draft.flags.length).toBeGreaterThan(0); // the line in the policies that tries to direct Bike
    const audit = await as((tx) => tx.select().from(auditEntries).where(and(eq(auditEntries.event, "plan.drafted"), eq(auditEntries.chatId, chatId))));
    expect(audit).toHaveLength(1);
  });

  it("plans again when the founder replies", async () => {
    sent.length = 0;
    const fewer = { ...PACK_PLAN, lead: "I've left out Customer contracts, so I'll build **5 capabilities**.", capabilities: PACK_PLAN.capabilities.slice(0, 5), connections: PACK_PLAN.connections.slice(0, 2) };
    plannerAnswers = [fewer];
    await as((tx, c) => send(tx, c, chatId, "Leave out customer contracts for now.", []));
    await runQueued(ws);

    // Straight to prompt 1, with the plan it replaces and what was said.
    expect(sent.map((r) => r.prompt)).toEqual(["workspace-planner@2"]);
    expect(sent[0]!.message).toContain("The current plan:");
    expect(sent[0]!.message).toContain("Wade Wilson: This is how we run");
    const reply = await lastReply(chatId);
    expect(reply.status).toBe("done");
    expect(tableOf(reply.parts).rows).toHaveLength(6);
    expect((await as((tx, c) => plansIn(tx, c, chatId))).map((p) => [p.version, p.status])).toEqual([[1, "replaced"], [2, "waiting"]]);
  });
});
