import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { capabilities } from "@/db/schema";
import { withProvider } from "@/server/ai/gateway";
import type { Provider, ProviderRequest, ProviderResponse } from "@/server/ai/providers/types";
import { tutorialFor } from "@/server/tutorials/write";
import { kernelWorkspace } from "@/tests/kernel";
import { recordFile } from "@/tests/record";
import { accessSummary } from "./access-summary";
import { saveVersion } from "./capabilities";
import { createRow } from "./rows";
import { checkTutorial, closeTutorial, tutorialState, type Tutorial } from "./tutorial";

// A capability's tutorial (0.4, M24), with a scripted model: checked against the reader's access (one retry), kept
// once per version and access and read back without a call, and its card: new, closed with "Got it", and back after
// a change only when the reader's own steps changed, with what's new marked.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let cap: string;

const step = (title: string, kind: Tutorial["steps"][number]["does"]["kind"], sheet = "Contracts", s: string | null = null) => ({ title, text: `${title}.`, does: { kind, sheet, step: s } });
const page = (...steps: ReturnType<typeof step>[]): Tutorial => ({ purpose: "Where contracts are kept.", steps, waits: [], cannot: [] });
const answer = (t: unknown): ProviderResponse => ({ model: "claude-haiku-5-5", text: JSON.stringify(t), stop: "done", usage: { tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 }, ms: 1 });
function scripted(...answers: unknown[]) {
  const sent: ProviderRequest[] = [];
  const p: Provider = { call: async (req) => (sent.push(req), answer(answers.shift() ?? page(step("Look", "read")))) };
  return { p, sent };
}

beforeAll(async () => {
  k = await kernelWorkspace();
  cap = await k.create(recordFile([k.id.ada]));
  await k.as("ada", (tx, c) => createRow(tx, c, cap, "contracts", { values: { customer: "Northwind", value: 3_840_000, owner: k.id.rita } }));
});

describe("checked against the reader's access", () => {
  it("refuses a step the reader can't take", async () => {
    const rita = await k.as("rita", (tx, c) => accessSummary(tx, c, cap));
    expect(checkTutorial(rita, page(step("Add a contract", "add")))).toEqual(["Step 1 (“Add a contract”): this person can't add to Contracts."]);
    expect(checkTutorial(rita, page(step("Look at contacts", "read", "Contacts")))).toEqual(["Step 1 (“Look at contacts”): “Contacts” isn't a sheet this person sees."]);
    expect(checkTutorial(rita, page(step("Move it on", "move", "Contracts", "Signed")))).toEqual([]);
  });
});

describe("written once, read back", () => {
  it("retries once with the kernel's problems, keeps the answer, and reads it back without a call", async () => {
    const m = scripted(page(step("Add a contract", "add")), page(step("Open your contracts", "read"), step("Move it on", "move", "Contracts", "Signed")));
    const first = await withProvider(m.p, () => tutorialFor(k.ctx("rita"), cap));
    expect(first.ok && first.state.tutorial.steps.map((s) => s.title)).toEqual(["Open your contracts", "Move it on"]);
    expect(m.sent).toHaveLength(2);
    expect(m.sent[1]!.retry?.problems).toEqual(["Step 1 (“Add a contract”): this person can't add to Contracts."]);
    const again = scripted();
    await withProvider(again.p, () => tutorialFor(k.ctx("rita"), cap));
    expect(again.sent).toHaveLength(0);
  });

  it("keeps nothing when both answers fail", async () => {
    // Omar owns nothing, so he has no access at all: refused before any call.
    const m = scripted();
    await expect(withProvider(m.p, () => tutorialFor(k.ctx("omar"), cap))).rejects.toThrow(/can't see it/);
    expect(m.sent).toHaveLength(0);
    const k2 = await kernelWorkspace();
    const cap2 = await k2.create(recordFile([k2.id.ada]));
    await k2.as("ada", (tx, c) => createRow(tx, c, cap2, "contracts", { values: { customer: "Kova", value: 1, owner: k2.id.rita } }));
    const failed = await withProvider(scripted(page(step("Add", "add")), page(step("Add", "add"))).p, () => tutorialFor(k2.ctx("rita"), cap2));
    expect(failed).toEqual({ ok: false, error: "Bike couldn't write Customer contracts's tutorial just now. Try again in a moment." });
    expect((await k2.as("rita", (tx, c) => tutorialState(tx, c, cap2))).ready).toBe(false);
  });
});

describe("the card", () => {
  const card = () => k.as("ada", (tx, c) => tutorialState(tx, c, cap)).then((s) => (s.ready ? s.card : "not written"));
  const write = (t: Tutorial) => withProvider(scripted(t).p, () => tutorialFor(k.ctx("ada"), cap));
  const bump = async (title: string) => {
    const file = (await k.as("ada", (tx) => tx.execute<{ file: unknown }>(sql`select v.file from capability_versions v join capabilities c on c.id = v.capability_id and v.version = c.current_version where c.id = ${cap}`)))[0]!.file;
    await k.as("ada", (tx, c) => saveVersion(tx, c, cap, file, { source: "customize", event: "customize.saved" }));
    await k.as("ada", (tx) => tx.update(capabilities).set({ introduce: true, changeTitle: title }).where(eq(capabilities.id, cap)));
  };

  it("shows on a new capability until Got it", async () => {
    await write(page(step("Add a contract", "add"), step("Sign it", "move", "Contracts", "Signed")));
    expect(await card()).toEqual({ kind: "new", change: null, isNew: [] });
    await k.as("ada", (tx, c) => closeTutorial(tx, c, cap));
    expect(await card()).toBeNull();
  });

  it("stays away after a change that leaves the reader's steps the same", async () => {
    await bump("Remind owners earlier");
    await write(page(step("Add a contract", "add"), step("Sign it", "move", "Contracts", "Signed")));
    expect(await card()).toBeNull();
  });

  it("comes back, named by the change, when the reader's steps change, with the new step marked", async () => {
    await bump("Legal review step");
    await write(page(step("Add a contract", "add"), step("Send big ones to legal", "move", "Contracts", "Legal review"), step("Sign it", "move", "Contracts", "Signed")));
    expect(await card()).toEqual({ kind: "changed", change: "Legal review step", isNew: ["Send big ones to legal"] });
  });

  it("is off for capabilities from before this release", async () => {
    const k3 = await kernelWorkspace();
    const old = await k3.create(recordFile([k3.id.ada]));
    await k3.as("ada", (tx) => tx.update(capabilities).set({ introduce: false }).where(eq(capabilities.id, old)));
    await withProvider(scripted(page(step("Add a contract", "add"))).p, () => tutorialFor(k3.ctx("ada"), old));
    expect(await k3.as("ada", (tx, c) => tutorialState(tx, c, old)).then((s) => s.ready && s.card)).toBeNull();
  });
});
