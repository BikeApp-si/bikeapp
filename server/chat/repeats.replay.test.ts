import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditEntries, people } from "@/db/schema";
import { seedFernwoodCopy } from "@/seed";
import { getFile } from "@/server/kernel/capabilities";
import { plansIn, readChat } from "@/server/kernel/chats";
import type { KernelCtx } from "@/server/kernel/context";
import { systemCtx } from "@/server/kernel/date-rules";
import { runRepeats } from "@/server/kernel/repeats";
import { listRows } from "@/server/kernel/rows";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { REPEATS } from "@/tests/repeats";
import { applyFromChat, sendCustomize } from "./customize";
import type { CustomizeDraft } from "./types";

// Rows that repeat (0.5, M32): Customize on Spend writes "every month on the 1st, add the office rent", replayed from
// the recorded answers (scripts/ai-record.ts) on a Fernwood as Playwright's copies have it. Behaviour, not wording:
// the preview reads the schedule and the row and adds nothing; Apply saves a repeating rule; the daily job then adds
// the rent once on the 1st, for Wade, and Maya never sees it.

let ws: string;
let spend: string;
const ids = new Map<string, string>();
const as = <T>(who: string, fn: (tx: Tx, c: KernelCtx) => Promise<T>) =>
  withWorkspace({ workspaceId: ws, personId: ids.get(who) }, (tx) => fn(tx, { workspaceId: ws, actor: { id: ids.get(who)!, email: `${who}@fernwood.dev` } }));
const rent = async (who = "wade") => (await as(who, (tx, c) => listRows(tx, c, spend, "expenses"))).filter((r) => r.data.what === "Office rent");

beforeAll(async () => {
  ws = (await seedFernwoodCopy(`fr${Date.now().toString(36)}`)).workspaceId;
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    for (const p of await tx.select({ id: people.id, email: people.email }).from(people)) ids.set(p.email.split("@")[0]!, p.id);
    spend = (await tx.execute<{ id: string }>(sql`select id from capabilities where name = 'Spend'`))[0]!.id;
  });
});

describe("rows that repeat, from Customize", () => {
  it("previews the schedule and the row it adds, adding nothing; Apply saves a repeating rule; the 1st adds the rent once", async () => {
    const out = await as("wade", (tx, c) => sendCustomize(tx, c, spend, REPEATS.customize));
    await out.work();
    const last = (await as("wade", (tx, c) => readChat(tx, c, out.chatId))).messages.at(-1)!;
    expect(last.status).toBe("done");
    const plan = (await as("wade", (tx, c) => plansIn(tx, c, out.chatId))).findLast((p) => p.status === "waiting")!;
    const draft = plan.draft as CustomizeDraft;
    expect(draft.rule?.repeats).toMatchObject({ next: "Nov 1, 2026", past: 3, pastWords: "Aug 1, Sep 1 and Oct 1, 2026" });
    expect(draft.rule?.when).toBe("Every month on the 1st, from Oct 27, 2026");
    expect(draft.rule?.repeats?.values.find((v) => v.person)?.text).toBe("Wade Wilson");
    expect(draft.rule?.repeats?.values.map((v) => v.text)).toEqual(expect.arrayContaining(["Office rent", "$2,400", "Office", "The 1st"]));
    expect(await rent()).toEqual([]);

    const applied = await as("wade", (tx, c) => applyFromChat(tx, c, out.chatId, plan.id));
    await applied.work();
    const file = (await as("wade", (tx) => getFile(tx, spend)))!.file;
    const rule = file.rules.find((r) => r.trigger.kind === "repeats")!;
    expect(rule.trigger).toMatchObject({ sheet: "expenses", every: { unit: "month", day: 1 } });

    const tick = (day: string) => as("wade", (tx) => runRepeats(tx, systemCtx(ws, new Date(`${day}T12:00:00Z`))));
    expect(await tick("2026-10-31")).toEqual({ added: 0 });
    expect(await tick("2026-11-01")).toEqual({ added: 1 });
    expect(await tick("2026-11-01")).toEqual({ added: 0 });
    const [row, ...more] = await rent();
    expect(more).toEqual([]);
    expect(row!.data).toMatchObject({ who: ids.get("wade"), date: "2026-11-01", amount: 240000, category: "office", paid_with: "company_card" });
    expect(await rent("maya")).toEqual([]);
    const entries = await as("wade", (tx) => tx.select().from(auditEntries).where(and(eq(auditEntries.event, "rule.ran"), eq(auditEntries.who, `rule:${rule.id}`))));
    expect(entries.map((e) => (e.details as { on: string }).on)).toEqual(["2026-11-01"]);
  });
});
