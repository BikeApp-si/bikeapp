import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { asc, desc, eq } from "drizzle-orm";
import { aiCalls, instanceSettings, people } from "@/db/schema";
import { withRoot, withWorkspace } from "@/server/kernel/tx";
import { forgetAiSettings, setAiCap } from "@/server/kernel/instance-settings";
import { CAP_REACHED } from "@/server/edition/open";
import { freshWorkspace } from "@/tests/helpers";
import { AiError, ask, BuildRefused, NoModel, TRY_AGAIN, unwrapped, useProvider, withoutToolCalls } from "./gateway";
import { costOf } from "./prices";
import type { Prompt } from "./prompt";
import { fixturesProvider, MissingFixture } from "./providers/fixtures";
import type { Provider, ProviderRequest, ProviderResponse } from "./providers/types";

const echo: Prompt<{ say: string }, { said: string }> = {
  name: "gateway-test",
  version: 1,
  model: "large",
  effort: "low",
  maxTokens: 100,
  structured: true,
  system: "Repeat the message.",
  schema: z.object({ said: z.string() }),
  render: ({ say }) => ({ context: "No context.", message: say }),
};

const usage = { tokensIn: 1_000, tokensOut: 500, cacheRead: 0, cacheWrite: 0 };
const answer = (text: string, stop: ProviderResponse["stop"] = "done"): ProviderResponse => ({ model: "claude-sonnet-5-5", text, stop, usage, ms: 5 });

// A provider that answers from a list and remembers what it was sent.
function scripted(...answers: ProviderResponse[]) {
  const sent: ProviderRequest[] = [];
  const p: Provider = { call: async (req) => (sent.push(req), answers.shift() ?? answer("{}")) };
  return { p, sent };
}

let ws: Awaited<ReturnType<typeof freshWorkspace>>;
const who = () => ({ workspaceId: ws.workspaceId, personId: null });
const calls = () => withWorkspace({ workspaceId: ws.workspaceId }, (tx) => tx.select().from(aiCalls).where(eq(aiCalls.prompt, "gateway-test")).orderBy(asc(aiCalls.at)));

beforeAll(async () => {
  ws = await freshWorkspace();
});
afterEach(() => useProvider(null));

describe("the gateway", () => {
  it("returns a valid answer and logs the call with its cost", async () => {
    const { p, sent } = scripted(answer('{"said":"hi"}'));
    useProvider(p);
    expect(await ask(echo, { say: "hi" }, who())).toEqual({ said: "hi" });
    expect(sent[0]).toMatchObject({ prompt: "gateway-test@1", model: "claude-sonnet-5-5", system: "Repeat the message.", context: "No context.", message: "hi" });
    expect(sent[0]!.jsonSchema).toMatchObject({ type: "object", required: ["said"] });
    const [c] = await calls();
    expect(c).toMatchObject({ version: 1, model: "claude-sonnet-5-5", tokensIn: 1_000, tokensOut: 500, attempt: 1, passed: true, problem: null });
    expect(Number(c!.costUsd)).toBeCloseTo(0.007, 6); // 1,000 × $2 + 500 × $10 per million
  });

  it("retries once with the problems, then uses the second answer", async () => {
    const { p, sent } = scripted(answer('{"said":"bye"}'), answer('{"said":"hi"}'));
    useProvider(p);
    const check = (o: { said: string }) => (o.said === "hi" ? [] : ["Say hi, not bye."]);
    expect(await ask(echo, { say: "hi" }, who(), { check })).toEqual({ said: "hi" });
    expect(sent[1]!.retry).toEqual({ answer: '{"said":"bye"}', problems: ["Say hi, not bye."] });
  });

  it("sends a retry the earlier answer without tool-call text (S1)", async () => {
    const stray = '<invoke name="bash">\n<parameter name="command">true</parameter>\n</invoke>\n\n{"said":"bye"}';
    const { p, sent } = scripted(answer(stray), answer('{"said":"hi"}'));
    useProvider(p);
    const check = (o: { said: string }) => (o.said === "hi" ? [] : ["Say hi, not bye."]);
    expect(await ask(echo, { say: "hi" }, who(), { check })).toEqual({ said: "hi" });
    expect(sent[1]!.retry).toEqual({ answer: '{"said":"bye"}', problems: ["Say hi, not bye."] });
    expect(withoutToolCalls('<invoke name="noop">\n</invoke>')).toBe("(no answer)");
  });

  it("takes an answer tool's input wrapped once under a name that isn't a field (S1), only for a prompt that answers through it", () => {
    const fields = ["said", "card"];
    expect(unwrapped({ answerTool: true }, { input: { said: "hi" } }, fields)).toEqual({ said: "hi" });
    expect(unwrapped({ answerTool: true }, { json: { said: "hi" } }, fields)).toEqual({ said: "hi" });
    expect(unwrapped({ answerTool: true }, { card: { said: "hi" } }, fields)).toEqual({ card: { said: "hi" } });
    expect(unwrapped({ answerTool: true }, { input: { said: "hi" }, other: 1 }, fields)).toEqual({ input: { said: "hi" }, other: 1 });
    expect(unwrapped({}, { input: { said: "hi" } }, fields)).toEqual({ input: { said: "hi" } });
  });

  it("gives the plain refusal after a second bad answer, and logs both", async () => {
    const before = (await calls()).length;
    useProvider(scripted(answer("not json"), answer('{"said":1}')).p);
    // The last answer's problems come with it (C1), for a caller that says why in its own words.
    await expect(ask(echo, { say: "hi" }, who())).rejects.toThrow(new AiError(TRY_AGAIN, ["said: Invalid input: expected string, received number"]));
    const logged = (await calls()).slice(before);
    expect(logged.map((c) => [c.attempt, c.passed])).toEqual([[1, false], [2, false]]);
    expect(logged[0]!.problem).toBe("The answer wasn't JSON.");
  });

  it("sends a large schema in the system prompt, and reads the JSON out of the answer", async () => {
    const { p, sent } = scripted(answer('Here it is:\n```json\n{"said":"hi"}\n```'));
    useProvider(p);
    expect(await ask({ ...echo, structured: false }, { say: "hi" }, who())).toEqual({ said: "hi" });
    expect(sent[0]!.structured).toBe(false);
    expect(sent[0]!.system).toMatch(/^Repeat the message\.\n\nThe JSON object follows this JSON Schema:\n\{/);
  });

  it("doesn't retry a refusal", async () => {
    const { p, sent } = scripted(answer("", "refused"));
    useProvider(p);
    await expect(ask(echo, { say: "hi" }, who())).rejects.toThrow(TRY_AGAIN);
    expect(sent).toHaveLength(1);
  });
});

describe("prices", () => {
  it("works out a call's cost per model, cache included", () => {
    expect(costOf("claude-sonnet-5-5", { tokensIn: 1_000_000, tokensOut: 100_000, cacheRead: 1_000_000, cacheWrite: 0 })).toBeCloseTo(2 + 1 + 0.2);
    expect(costOf("claude-haiku-5-5", { tokensIn: 50_000, tokensOut: 10_000, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(0.005 + 0.005);
    // Over 100K tokens of input, Haiku's higher price applies.
    expect(costOf("claude-haiku-5-5", { tokensIn: 200_000, tokensOut: 10_000, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(0.1 + 0.025);
    expect(costOf("claude-opus-5-5", { tokensIn: 1_000_000, tokensOut: 0, cacheRead: 0, cacheWrite: 0 })).toBe(4);
  });
});

describe("recorded answers", () => {
  const dir = path.join(process.cwd(), "server/ai/fixtures/gateway-test@1");
  afterEach(() => rm(dir, { recursive: true, force: true }));
  const req: ProviderRequest = { prompt: "gateway-test@1", model: "m", effort: "low", maxTokens: 10, system: "s", context: "c", message: "hello", jsonSchema: {}, structured: true };

  it("records a real answer once, then replays it without calling again", async () => {
    const real = scripted(answer('{"said":"recorded"}'));
    expect((await fixturesProvider(real.p).call(req)).text).toBe('{"said":"recorded"}');
    expect((await fixturesProvider(real.p).call(req)).text).toBe('{"said":"recorded"}');
    expect(real.sent).toHaveLength(1);
    expect((await fixturesProvider().call(req)).text).toBe('{"said":"recorded"}');
  });

  it("says when nothing is recorded for a request", async () => {
    await expect(fixturesProvider().call({ ...req, message: "never sent" })).rejects.toThrow(MissingFixture);
  });
});

// O3: the open Bike with no key asks nothing; its monthly cap stops building, never work that keeps going.
describe("no model, and the monthly cap", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    delete process.env.BIKE_MODE;
    await withRoot((tx) => tx.update(instanceSettings).set({ aiCapUsd: null }).where(eq(instanceSettings.id, 1)));
    forgetAiSettings();
  });

  it("with no key, nothing is asked and the call says it needs a model", async () => {
    vi.stubEnv("AI_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const before = (await calls()).length;
    await expect(ask(echo, { say: "hi" }, who())).rejects.toThrow(new NoModel());
    await expect(ask(echo, { say: "hi" }, who(), { building: false })).rejects.toBeInstanceOf(AiError);
    expect((await calls()).length).toBe(before);
  });

  it("once this month's use reaches the cap, building waits and work that keeps going doesn't", async () => {
    process.env.BIKE_MODE = "single";
    const own = await freshWorkspace(); // nothing spent this month yet
    const me = { workspaceId: own.workspaceId, personId: null };
    const admin = await withWorkspace({ workspaceId: own.workspaceId }, (tx) => tx.select({ id: people.id, email: people.email }).from(people).where(eq(people.isAdmin, true)));
    const ctx = { workspaceId: own.workspaceId, actor: admin[0]! };
    await withWorkspace({ workspaceId: own.workspaceId, personId: admin[0]!.id }, (tx) => setAiCap(tx, ctx, 0.01));
    useProvider(scripted(answer('{"said":"hi"}'), answer('{"said":"hi"}'), answer('{"said":"hi"}')).p);
    expect(await ask(echo, { say: "hi" }, me)).toEqual({ said: "hi" }); // $0.007 of $0.01
    expect(await ask(echo, { say: "hi" }, me)).toEqual({ said: "hi" }); // now $0.014
    await expect(ask(echo, { say: "hi" }, me)).rejects.toThrow(new BuildRefused(CAP_REACHED(0.01)));
    expect(await ask(echo, { say: "hi" }, me, { building: false })).toEqual({ said: "hi" });
    expect(CAP_REACHED(50)).toBe("This month’s AI cap of $50 is reached, so building and changing apps waits until the 1st. An admin can raise it in Settings › AI.");
  });
});
