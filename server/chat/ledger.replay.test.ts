import { runQueued } from "@/server/jobs/run";
import "@/server/jobs/runners";
import { beforeAll, describe, expect, it } from "vitest";
import { people } from "@/db/schema";
import { seedWorkspace } from "@/seed";
import { seedCapabilities } from "@/seed/capabilities";
import { FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES } from "@/seed/fernwood";
import { addMessage, getPlan, readChat, startChat } from "@/server/kernel/chats";
import { KernelError, type KernelCtx } from "@/server/kernel/context";
import { getFile } from "@/server/kernel/capabilities";
import { createRow, getRow } from "@/server/kernel/rows";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { LEDGERS } from "@/tests/ledgers";
import { runCreate } from "./create";
import { runDesign } from "./design";
import type { PlanDraft } from "./types";

// Prompt 2 learns ledgers (0.5, M29): office equipment with moves in and out that can't take stock below zero, from
// Home's chat, replayed from the recorded answer (scripts/ai-record.ts) on a Fernwood without Customer contracts.
// Behaviour, not wording: the plan has a ledger whose lowest balance is 0, Create makes it, and a move that would
// take an item below zero is refused.

let ws: string;
const ids = new Map<string, string>();
const wade = () => ({ id: ids.get("wade")!, email: "wade@fernwood.dev" });
const as = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: ws, personId: ids.get("wade") }, (tx) => fn(tx, { workspaceId: ws, actor: wade() }));

beforeAll(async () => {
  ws = (await seedWorkspace({ subdomain: `fl${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
  await seedCapabilities(ws, { contracts: false });
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    for (const p of await tx.select({ id: people.id, email: people.email }).from(people)) ids.set(p.email.split("@")[0]!, p.id);
  });
});

describe("a ledger from Home's chat", () => {
  it("plans stock moves as a ledger that can't go below zero, and Create makes one", async () => {
    const chat = (await as((tx, c) => startChat(tx, c, "capability", { text: LEDGERS.build }))).chatId;
    const replyId = await as((tx, c) => addMessage(tx, c, chat, { from: "bike", text: "", status: "working" }));
    await runDesign({ workspaceId: ws, person: wade(), chatId: chat, replyId, text: LEDGERS.build, documents: [] });
    const m = (await as((tx, c) => readChat(tx, c, chat))).messages.find((x) => x.id === replyId)!;
    expect(m.status).toBe("done");
    const planId = (m.parts[0] as { planId: string }).planId;
    const draft = (await as((tx, c) => getPlan(tx, c, planId))).draft as PlanDraft;
    const ledger = draft.design.capability!.sheets.find((s) => s.kind === "ledger")!;
    expect(ledger).toMatchObject({ ledger_min: 0 });

    const created = await as((tx, c) => addMessage(tx, c, chat, { from: "bike", text: "", status: "working" }));
    await runCreate({ workspaceId: ws, person: wade(), chatId: chat, replyId: created, planId, withImport: false, withoutRestructure: false });
    await runQueued(ws);
    const capId = (await as((tx, c) => getPlan(tx, c, planId))).capabilityId!;
    const file = (await as((tx) => getFile(tx, capId)))!.file;
    const moves = file.sheets.find((s) => s.kind === "ledger")!;
    const l = moves.ledger!;
    expect(l.min).toBe(0);
    const account = moves.columns.find((c) => c.id === l.account)!;
    expect(account.type).toBe("link");
    const items = file.sheets.find((s) => s.id === account.link!.sheet)!;

    // An item with what every question of its sheet needs, then a move in and one too many out.
    const fill = (sheet: typeof items, given: Record<string, unknown>) => {
      const out: Record<string, unknown> = { ...given };
      for (const c of sheet.columns) {
        if (!c.required || c.id in out || c.default) continue;
        out[c.id] = c.type === "choice" ? c.options![0]!.id : c.type === "person" ? ids.get("wade") : c.type === "date" ? "2026-10-27" : ["number", "money", "days"].includes(c.type) ? 1 : "Laptops";
      }
      return out;
    };
    const item = await as((tx, c) => createRow(tx, c, capId, items.id, { values: fill(items, { [items.titleColumn]: "Laptops" }) })).then((r) => r.id);
    const move = (n: number) => as((tx, c) => createRow(tx, c, capId, moves.id, { values: fill(moves, { [l.account]: item, [l.amount]: n }) }));
    await move(2);
    const refused = await move(-3).then(
      () => "saved",
      (e: unknown) => (e instanceof KernelError ? e.message : Promise.reject(e)),
    );
    expect(refused).toBe("Laptops has 2, so 3 can't be taken.");
    // The item shows what is in stock.
    const shown = items.columns.find((c) => c.type === "computed" && JSON.stringify(c.expr).includes("balanceOf"))!;
    expect((await as((tx, c) => getRow(tx, c, item))).data[shown.id]).toBe(2);
  });
});
