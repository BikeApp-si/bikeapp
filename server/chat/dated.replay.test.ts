import { runQueued } from "@/server/jobs/run";
import "@/server/jobs/runners";
import { beforeAll, describe, expect, it } from "vitest";
import { people } from "@/db/schema";
import { seedWorkspace } from "@/seed";
import { seedCapabilities } from "@/seed/capabilities";
import { FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES } from "@/seed/fernwood";
import { addMessage, getPlan, readChat, startChat } from "@/server/kernel/chats";
import type { KernelCtx } from "@/server/kernel/context";
import { getFile } from "@/server/kernel/capabilities";
import { createRow, getRow } from "@/server/kernel/rows";
import { isInForce, walk } from "@/server/kernel/expr/ast";
import type { Sheet } from "@/server/kernel/schema/file";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { DATED } from "@/tests/dated";
import { runCreate } from "./create";
import { runDesign } from "./design";
import type { PlanDraft } from "./types";

// Prompt 2 learns sheets kept by date (0.5, M30): a price list with each product's price from the date it starts, and
// quotes that show the price in force on their date, from Home's chat, replayed from the recorded answer
// (scripts/ai-record.ts) on a Fernwood without Customer contracts. Behaviour, not wording: the plan has a sheet kept by
// date, Create makes it, and quotes before and after a change show the old and the new price.

let ws: string;
const ids = new Map<string, string>();
const wade = () => ({ id: ids.get("wade")!, email: "wade@fernwood.dev" });
// The seed's today: a price from Nov 1 is still to come.
const NOW = new Date("2026-10-27T15:00:00Z");
const as = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: ws, personId: ids.get("wade") }, (tx) => fn(tx, { workspaceId: ws, actor: wade(), now: NOW }));

beforeAll(async () => {
  ws = (await seedWorkspace({ subdomain: `fd${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
  await seedCapabilities(ws, { contracts: false });
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    for (const p of await tx.select({ id: people.id, email: people.email }).from(people)) ids.set(p.email.split("@")[0]!, p.id);
  });
});

describe("a price list from Home's chat", () => {
  it("plans prices kept by date, and quotes show the price in force on their date", async () => {
    const chat = (await as((tx, c) => startChat(tx, c, "capability", { text: DATED.build }))).chatId;
    const replyId = await as((tx, c) => addMessage(tx, c, chat, { from: "bike", text: "", status: "working" }));
    await runDesign({ workspaceId: ws, person: wade(), chatId: chat, replyId, text: DATED.build, documents: [] });
    const m = (await as((tx, c) => readChat(tx, c, chat))).messages.find((x) => x.id === replyId)!;
    expect(m.status).toBe("done");
    const planId = (m.parts[0] as { planId: string }).planId;
    const draft = (await as((tx, c) => getPlan(tx, c, planId))).draft as PlanDraft;
    expect(draft.design.capability!.sheets.some((s) => s.kind === "dated")).toBe(true);

    const created = await as((tx, c) => addMessage(tx, c, chat, { from: "bike", text: "", status: "working" }));
    await runCreate({ workspaceId: ws, person: wade(), chatId: chat, replyId: created, planId, withImport: false, withoutRestructure: false });
    await runQueued(ws);
    const capId = (await as((tx, c) => getPlan(tx, c, planId))).capabilityId!;
    const file = (await as((tx) => getFile(tx, capId)))!.file;
    const prices = file.sheets.find((s) => s.kind === "dated")!;
    const d = prices.dated!;
    const key = prices.columns.find((c) => c.id === d.key)!;
    expect(key.type).toBe("link");
    const products = file.sheets.find((s) => s.id === key.link!.sheet)!;
    // The quote's question that reads the price in force, on one of its dates.
    const quotes = file.sheets.find((s) => s.columns.some((c) => c.expr && [...walk(c.expr)].some((n) => isInForce(n) && n.inForce.sheet === prices.id && !!n.inForce.on)))!;
    const shown = quotes.columns.find((c) => c.expr && [...walk(c.expr)].some((n) => isInForce(n) && n.inForce.sheet === prices.id))!;
    const reads = [...walk(shown.expr!)].find(isInForce)!.inForce;

    const fill = (sheet: Sheet, given: Record<string, unknown>) => {
      const out: Record<string, unknown> = { ...given };
      for (const c of sheet.columns) {
        if (!c.required || c.id in out || c.default || c.type === "step") continue;
        out[c.id] = c.type === "choice" ? c.options![0]!.id : c.type === "person" ? ids.get("wade") : c.type === "date" ? "2026-10-27" : ["number", "money", "days", "percent"].includes(c.type) ? 1 : "Laptop";
      }
      return out;
    };
    const add = (sheet: Sheet, given: Record<string, unknown>) => as((tx, c) => createRow(tx, c, capId, sheet.id, { values: fill(sheet, given) })).then((r) => r.id);
    const laptop = await add(products, { [products.titleColumn]: "Laptop" });
    const priceCol = prices.columns.find((c) => c.id === reads.value)!.id;
    await add(prices, { [d.key!]: laptop, [d.from]: "2026-01-01", [priceCol]: 120000 });
    await add(prices, { [d.key!]: laptop, [d.from]: "2026-11-01", [priceCol]: 110000 });
    // A quote names its product by the column matched to the price list's key.
    const before = await add(quotes, { [reads.is!]: laptop, [reads.on!]: "2026-10-20" });
    const after = await add(quotes, { [reads.is!]: laptop, [reads.on!]: "2026-11-03" });
    expect((await as((tx, c) => getRow(tx, c, before))).data[shown.id]).toBe(120000);
    expect((await as((tx, c) => getRow(tx, c, after))).data[shown.id]).toBe(110000);
  });
});
