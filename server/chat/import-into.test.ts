import { runQueued } from "@/server/jobs/run";
import "@/server/jobs/runners";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { auditEntries, people } from "@/db/schema";
import { seedWorkspace } from "@/seed";
import { seedCapabilities } from "@/seed/capabilities";
import { FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES } from "@/seed/fernwood";
import { useProvider } from "@/server/ai/gateway";
import { applyPlan } from "@/server/kernel/changesets";
import { readChat } from "@/server/kernel/chats";
import type { KernelCtx } from "@/server/kernel/context";
import { planContext } from "@/server/kernel/plans/context";
import { contractRules, contracts } from "@/server/kernel/plans/fixtures";
import { checkPlan } from "@/server/kernel/plans/plan";
import { listRows } from "@/server/kernel/rows";
import { saveUpload } from "@/server/kernel/uploads";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { importNow, send } from "./send";

// 5i's Import a spreadsheet: a CSV into a capability that exists, checked first, then imported all at once.

let ws: string;
const ids = new Map<string, string>();
const capId = crypto.randomUUID();
const person = (n: string) => ({ id: ids.get(n)!, email: `${n}@fernwood.dev` });
const as = <T>(n: string, fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: ws, personId: ids.get(n) }, (tx) => fn(tx, { workspaceId: ws, actor: person(n) }));

// Prompt 2b's answer, as the small model gives it for contracts.csv.
const mapping = {
  mapping: [
    { from: "Client", to: "Customer", format: null, values: [] },
    { from: "ARR", to: "Value a year", format: null, values: [] },
    { from: "Start date", to: "Start", format: "MM/DD/YYYY", values: [] },
    { from: "Renewal", to: "Renews on", format: "MM/DD/YYYY", values: [] },
    { from: "Account owner", to: "Owner", format: null, values: [] },
    { from: "Stage", to: "Status", format: null, values: [] },
  ],
  unmapped: ["Notes", "Region", "Contract ID"],
  problems: [],
};

beforeAll(async () => {
  ws = (await seedWorkspace({ subdomain: `ii${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
  await seedCapabilities(ws, { contracts: false });
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    for (const p of await tx.select({ id: people.id, email: people.email }).from(people)) ids.set(p.email.split("@")[0]!, p.id);
  });
  // Customer contracts, created empty (5i).
  await as("wade", async (tx, c) => {
    const pc = await planContext(tx, c);
    const plan = checkPlan({ capability: contracts, rules: contractRules, alsoChanges: [] }, { newId: capId, files: pc.files, people: pc.peopleByEmail });
    await applyPlan(tx, c, { plan, newId: capId, chatId: crypto.randomUUID(), changes: new Map() });
  });
  useProvider({ call: async () => ({ model: "claude-haiku-5-5", text: JSON.stringify(mapping), stop: "done", usage: { tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 }, ms: 1 }) });
});
afterAll(() => useProvider(null));

describe("importing a spreadsheet into a capability that exists", () => {
  let chatId: string;
  let replyId: string;

  it("checks the file against the capability's sheet and says what it will do", async () => {
    const up = await as("wade", (tx, c) => saveUpload(tx, c, { name: "contracts.csv", body: readFileSync("tests/files/contracts.csv") }));
    const out = await as("wade", (tx, c) => send(tx, c, null, "", [up.id], capId));
    await runQueued(ws);
    chatId = out.chatId;
    const { messages } = await as("wade", (tx, c) => readChat(tx, c, chatId));
    const reply = messages.at(-1)!;
    replyId = reply.id;
    expect(reply.status).toBe("done");
    const part = reply.parts[0]!;
    if (part.kind !== "import_rows") throw new Error("no import");
    expect(part).toMatchObject({ capabilityId: capId, capability: "Customer contracts", draft: { rows: 12, columns: 9 } });
    expect(part.draft.checks.map((c) => c.row)).toEqual(["Brightline", "Sable Analytics"]);
    expect(await as("wade", (tx, c) => listRows(tx, c, capId, "contracts"))).toHaveLength(0);
  });

  it("imports the 12 rows on Import, once, with an Audit entry pointing to the chat", async () => {
    await as("wade", (tx, c) => importNow(tx, c, chatId, replyId, "Import 12 contracts"));
    expect(await as("wade", (tx, c) => listRows(tx, c, capId, "contracts"))).toHaveLength(12);
    const { messages } = await as("wade", (tx, c) => readChat(tx, c, chatId));
    expect(messages.slice(-2).map((m) => m.text)).toEqual(["Import 12 contracts", "**12 contracts** are in Customer contracts."]);
    const [entry] = await as("wade", (tx) => tx.select().from(auditEntries).where(and(eq(auditEntries.event, "import.done"), eq(auditEntries.chatId, chatId))));
    expect(entry!.details).toEqual({ file: "contracts.csv", rows: 12 });
    await expect(as("wade", (tx, c) => importNow(tx, c, chatId, replyId, "Import 12 contracts"))).rejects.toThrow("Those rows have already been imported.");
    expect(await as("wade", (tx, c) => listRows(tx, c, capId, "contracts"))).toHaveLength(12);
  });
});
