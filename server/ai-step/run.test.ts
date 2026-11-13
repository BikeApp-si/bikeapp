import { runQueued } from "@/server/jobs/run";
import "@/server/jobs/runners";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { aiSteps, auditEntries, proposals } from "@/db/schema";
import { NoModel, useProvider } from "@/server/ai/gateway";
import type { ProviderRequest } from "@/server/ai/providers/types";
import { kernelWorkspace } from "@/tests/kernel";
import { changeProposal, confirmProposal, confirmSure, proposalsFor } from "@/server/kernel/proposals";
import { createRow, getRow, moveStep, updateRow } from "@/server/kernel/rows";
import type { CapabilityFile } from "@/server/kernel/schema/file";
import { saveUpload } from "@/server/kernel/uploads";

// An AI step end to end (8h), with a stand-in for prompt 5: a rule queues it, the worker runs it, and the
// suggestion waits on the person the rule names. Only Confirm or Change writes the row; the row doesn't move
// on before.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let spend: string;
const sent: ProviderRequest[] = [];
let answers: { value: string; reason: string; confidence: number }[] = [];

const file = (): CapabilityFile => ({
  name: "Spend",
  icon: "wallet",
  sheets: [
    {
      id: "expenses",
      name: "Expenses",
      kind: "list",
      titleColumn: "what",
      row: { one: "expense", many: "expenses" },
      columns: [
        { id: "what", name: "What for", type: "text", required: true },
        { id: "category", name: "Category", type: "choice", options: [{ id: "travel", name: "Travel" }, { id: "software", name: "Software" }, { id: "other", name: "Other" }] },
        { id: "receipt", name: "Receipt", type: "file" },
        { id: "status", name: "Status", type: "step" },
      ],
      steps: [
        { id: "submitted", name: "Submitted", start: true },
        { id: "approved", name: "Approved", end: "final" },
      ],
    },
  ],
  roles: [{ id: "all", name: "Everyone", members: { kind: "everyone" }, can: ["see", "add", "edit", "move_steps"], scope: "all" }],
  rules: [
    {
      id: "suggest_category",
      text: "An expense without a category: an AI step suggests one, Rita confirms.",
      reading: { when: "An expense without a category is added", then: "An AI step suggests one; Rita confirms" },
      trigger: { kind: "row_created", sheet: "expenses" },
      condition: { op: "empty", args: [{ col: "category" }] },
      actions: [{ kind: "ai_step", question: "Which category is this expense?", column: "category", person: k.id.rita }],
      enabled: true,
    },
  ],
  later: [],
});

beforeAll(async () => {
  k = await kernelWorkspace();
  spend = await k.create(file());
  useProvider({
    call: async (req) => {
      sent.push(req);
      return { model: "claude-haiku-5-5", text: JSON.stringify({ ...answers.shift()!, flags: [] }), stop: "done", usage: { tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 }, ms: 1 };
    },
  });
});
afterAll(() => useProvider(null));

const add = (what: string, extra: Record<string, unknown> = {}) => k.as("maya", (tx, c) => createRow(tx, c, spend, "expenses", { values: { what, ...extra } })).then((r) => r.id);

describe("an AI step suggests, a person confirms", () => {
  let taxi: string;

  it("queues on the rule, runs in the worker, and waits on Rita without touching the row", async () => {
    answers = [{ value: "Travel", reason: "A taxi fare", confidence: 0.92 }];
    taxi = await add("Taxi to the airport");
    await runQueued(k.workspaceId);
    expect(sent.at(-1)!.message).toContain("Taxi to the airport");
    expect((await k.as("maya", (tx, c) => getRow(tx, c, taxi))).data.category).toBeUndefined();
    const forRita = await k.as("rita", (tx, c) => proposalsFor(tx, c, spend));
    expect(forRita.map((p) => [p.column, p.value, p.reason, p.sure])).toEqual([["Category", "Travel", "A taxi fare", true]]);
    expect(await k.as("ada", (tx, c) => proposalsFor(tx, c, spend))).toEqual([]);
  });

  it("holds the row until it is settled, and only Rita settles it", async () => {
    await expect(k.as("rita", (tx, c) => moveStep(tx, c, taxi, "approved"))).rejects.toThrow("Taxi to the airport has a suggested Category to confirm or change before it moves on.");
    const [p] = await k.as("rita", (tx, c) => proposalsFor(tx, c, spend));
    await expect(k.as("ada", (tx, c) => confirmProposal(tx, c, p!.id))).rejects.toThrow("waits on someone else");
    await k.as("rita", (tx, c) => confirmProposal(tx, c, p!.id));
    expect((await k.as("maya", (tx, c) => getRow(tx, c, taxi))).data.category).toBe("travel");
    await k.as("rita", (tx, c) => moveStep(tx, c, taxi, "approved"));
    const events = await k.as("ada", (tx) => tx.select({ event: auditEntries.event }).from(auditEntries).where(eq(auditEntries.capabilityId, spend)));
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(["proposal.created", "proposal.confirmed"]));
  });

  it("Change writes the person's own value; Confirm the sure ones leaves the unsure", async () => {
    answers = [
      { value: "Software", reason: "Sounds like a licence", confidence: 0.55 },
      { value: "Software", reason: "Figma seat", confidence: 0.95 },
    ];
    const cables = await add("HDMI cables");
    const figma = await add("Figma seat");
    await runQueued(k.workspaceId);
    expect(await k.as("rita", (tx, c) => confirmSure(tx, c, spend))).toBe(1);
    expect((await k.as("maya", (tx, c) => getRow(tx, c, figma))).data.category).toBe("software");
    const [unsure] = await k.as("rita", (tx, c) => proposalsFor(tx, c, spend));
    expect(unsure!.sure).toBe(false);
    await k.as("rita", (tx, c) => changeProposal(tx, c, unsure!.id, "other"));
    expect((await k.as("maya", (tx, c) => getRow(tx, c, cables))).data.category).toBe("other");
    const [changed] = await k.as("ada", (tx) => tx.select().from(proposals).where(eq(proposals.id, unsure!.id)));
    expect(changed!.status).toBe("changed");
  });

  it("an answer the column doesn't take is sent back once, then the step fails and nothing waits", async () => {
    answers = [
      { value: "Snacks", reason: "Food", confidence: 0.9 },
      { value: "Snacks", reason: "Food", confidence: 0.9 },
    ];
    const cookies = await add("Cookies");
    await runQueued(k.workspaceId);
    expect(sent.at(-1)!.retry?.problems.join(" ")).toContain("“Snacks” isn't one of Category's choices");
    const [step] = await k.as("ada", (tx) => tx.select().from(aiSteps).where(eq(aiSteps.rowId, cookies)));
    expect(step!.status).toBe("failed");
    expect(await k.as("rita", (tx, c) => proposalsFor(tx, c, spend))).toEqual([]);
  });

  it("with no model, the step is skipped and nothing waits", async () => {
    let noModel = true;
    const before = sent.length;
    useProvider({ call: async () => { if (noModel) throw new NoModel(); throw new Error("not asked"); } });
    try {
      const lunch = await add("Team lunch");
      await runQueued(k.workspaceId);
      const [step] = await k.as("ada", (tx) => tx.select().from(aiSteps).where(eq(aiSteps.rowId, lunch)));
      expect(step!.status).toBe("skipped");
      expect(sent.length).toBe(before);
    } finally {
      noModel = false;
      useProvider({
        call: async (req) => {
          sent.push(req);
          return { model: "claude-haiku-5-5", text: JSON.stringify({ ...answers.shift()!, flags: [] }), stop: "done", usage: { tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 }, ms: 1 };
        },
      });
    }
  });

  it("reads a receipt photo the row holds", async () => {
    answers = [{ value: "Travel", reason: "Receipt shows a train ticket", confidence: 0.9 }];
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64"));
    const upload = await k.as("maya", (tx, c) => saveUpload(tx, c, { name: "ticket.png", body: png }));
    const id = await add("Train", {});
    await k.as("maya", (tx, c) => updateRow(tx, c, id, { receipt: upload.id }));
    // The step was queued when the row was added, before the receipt: run it now that the row holds one.
    await runQueued(k.workspaceId);
    expect(sent.at(-1)!.images?.[0]?.mediaType).toBe("image/png");
  });
});
