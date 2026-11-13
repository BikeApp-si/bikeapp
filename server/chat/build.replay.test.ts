import { runQueued } from "@/server/jobs/run";
import "@/server/jobs/runners";
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { auditEntries, capabilities, people } from "@/db/schema";
import { seedWorkspace } from "@/seed";
import { FERNWOOD_ADMIN } from "@/seed/fernwood";
import { readChat, type Part } from "@/server/kernel/chats";
import type { KernelCtx } from "@/server/kernel/context";
import { getFile } from "@/server/kernel/capabilities";
import { listHolidays } from "@/server/kernel/holidays";
import { countRows } from "@/server/kernel/rows";
import { saveUpload } from "@/server/kernel/uploads";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { STEP4 } from "@/tests/step4";
import { answerBuild, startBuild } from "./build";
import { send } from "./send";

// Step 4 replayed from the answers recorded on the synthetic pack (pnpm ai:record): the message with the
// three files on a Fernwood with only its founder, the plan, Build all. Checks what the kernel did with the
// model's answers, never their wording: every table in the sheet it belongs to, People filled, the flagged
// page recorded.

let ws: string;
let wade: { id: string; email: string };
const as = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: ws, personId: wade.id }, (tx) => fn(tx, { workspaceId: ws, actor: wade }));
let chatId: string;

beforeAll(async () => {
  ws = (await seedWorkspace({ subdomain: `br${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, [])).workspaceId;
  const [u] = await withWorkspace({ workspaceId: ws }, (tx) => tx.select({ id: people.id, email: people.email }).from(people));
  wade = u!;
}, 30_000);

const last = async () => (await as((tx, c) => readChat(tx, c, chatId))).messages.at(-1)!;
const capNamed = async (name: string) => (await as((tx) => tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, name))))[0]!.id;

describe("a build from the synthetic pack, replayed", () => {
  it("plans People and 6 capabilities", async () => {
    const ids: string[] = [];
    for (const f of STEP4.files) ids.push((await as((tx, c) => saveUpload(tx, c, { name: f.split("/").pop()!, body: readFileSync(f) }))).id);
    chatId = (await as((tx, c) => send(tx, c, null, STEP4.message, ids))).chatId;
    await runQueued(ws);
    const plan = await last();
    expect(plan.status).toBe("done");
    const table = plan.parts.find((p) => p.kind === "table") as Extract<Part, { kind: "table" }>;
    expect(table.rows).toHaveLength(7);
    expect(table.rows[0]![1]).toBe("People");
  }, 60_000);

  it("builds them all, each table in its own sheet", async () => {
    await as((tx, c) => startBuild(tx, c, chatId, "Build all"));
    await runQueued(ws);
    let done = await last();
    if (done.parts.some((p) => p.kind === "buttons")) {
      await as((tx, c) => answerBuild(tx, c, chatId, 0));
      await runQueued(ws);
      done = await last();
    }
    expect(done.status).toBe("done");
    expect(done.parts[0]).toMatchObject({ kind: "text", text: expect.stringContaining("3,214 of 3,214 rows imported") });
    expect(await withWorkspace({ workspaceId: ws }, (tx) => tx.select().from(people))).toHaveLength(14);

    // The candidates are in Hiring's Candidates sheet and nowhere else, whichever sheet comes first.
    const hiring = await capNamed("Hiring");
    const file = (await as((tx) => getFile(tx, hiring)))!.file;
    const counts = Object.fromEntries(await Promise.all(file.sheets.map(async (s) => [s.name, await as((tx, c) => countRows(tx, c, hiring, s.id))])));
    expect(counts).toEqual({ ...Object.fromEntries(file.sheets.map((s) => [s.name, 0])), Candidates: 46 });
    const spend = await capNamed("Spend");
    const spendFile = (await as((tx) => getFile(tx, spend)))!.file;
    expect(await as((tx, c) => countRows(tx, c, spend, spendFile.sheets.find((s) => s.name === "Expenses")!.id))).toBe(2890);

    // The 10 public holidays on page 13 of the policies are kept, and 4d says so.
    const holidays = await as((tx) => listHolidays(tx));
    expect(holidays).toHaveLength(10);
    expect(holidays.every((h) => h.file === "Fernwood policies.pdf" && h.page === 13)).toBe(true);
    expect(done.parts[0]).toMatchObject({ text: expect.stringContaining("I kept the 10 public holidays your policies list (p. 13).") });
    expect(done.parts[0]).toMatchObject({ text: expect.stringContaining("I’ve written the Ontology page from them.") });

    const flagged = await as((tx) => tx.select().from(auditEntries).where(and(eq(auditEntries.event, "document.flagged"), eq(auditEntries.chatId, chatId))));
    expect(flagged.map((f) => (f.details as { page: number }).page)).toEqual([24]);
  }, 120_000);
});
