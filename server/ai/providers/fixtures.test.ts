import { afterAll, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fixturesProvider, keyOf } from "./fixtures";
import type { Provider, ProviderRequest, ProviderResponse } from "./types";

// Recording keeps only answers that finished: one cut off at its limit, or refused, would replay the same failure
// on every later run (M28).

const PROMPT = "fixtures-test@1";
const dir = path.join(process.cwd(), "server/ai/fixtures", PROMPT);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const req = (message: string): ProviderRequest => ({ prompt: PROMPT, model: "m", effort: "low", maxTokens: 10, system: "s", context: "c", message, jsonSchema: {}, structured: true });
const answering = (stop: ProviderResponse["stop"]): Provider => ({
  call: async () => ({ model: "m", text: "{}", stop, usage: { tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 }, ms: 1 }),
});

describe("recording", () => {
  it("keeps an answer that finished, and not one cut off or refused", async () => {
    for (const [stop, kept] of [["done", true], ["too_long", false], ["refused", false]] as const) {
      const r = req(`a ${stop} answer`);
      expect((await fixturesProvider(answering(stop)).call(r)).stop).toBe(stop);
      expect(existsSync(path.join(dir, `${keyOf(r)}.json`))).toBe(kept);
    }
  });
});
