import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { logCall, type Who } from "./log";
import { edition } from "@/edition";
import { modelFor, type Prompt } from "./prompt";
import { anthropicProvider } from "./providers/anthropic";
import { fixturesProvider } from "./providers/fixtures";
import type { Provider, ProviderRequest } from "./providers/types";

// The one way Bike calls a model. It lays out the request, checks the answer against the prompt's schema and
// then the kernel's own check (every name, type and person), retries once with the problems, and logs every
// call. The answer is only ever a plan, rules or a mapping: nothing here writes to the database.

import { AiError, BuildRefused, NoModel, TRY_AGAIN } from "./errors";
import { hasModel } from "@/server/kernel/instance-settings";
export { AiError, BuildRefused, NEEDS_MODEL, NoModel, TRY_AGAIN } from "./errors";

// Returns the problems a valid-looking answer still has, in plain words; none when it can be used.
export type Check<O> = (output: O) => string[] | Promise<string[]>;

let override: Provider | null = null;
// Tests can put a provider in place of the one the environment names.
export function useProvider(p: Provider | null) {
  override = p;
}

// Runs fn with this provider, then puts back whatever was in place (the seed replays recorded answers this
// way inside tests that use their own stand-in).
export async function withProvider<T>(p: Provider, fn: () => Promise<T>): Promise<T> {
  const before = override;
  override = p;
  try {
    return await fn();
  } finally {
    override = before;
  }
}

function provider(): Provider {
  if (override) return override;
  switch (process.env.AI_PROVIDER ?? "anthropic") {
    case "fixtures":
      return fixturesProvider();
    case "record":
      return fixturesProvider(anthropicProvider);
    default:
      return anthropicProvider;
  }
}

// building: a call that starts something new (a plan, a capability). The edition may stop these (hosted: with no
// AI credits left); calls that keep work going are never stopped.
export async function ask<I, O>(prompt: Prompt<I, O>, input: I, who: Who, opts: { check?: Check<O>; building?: boolean } = {}): Promise<O> {
  // No key and no recorded answers: nothing is asked, and the caller says so plainly (O3).
  if (!override && !(await hasModel())) throw new NoModel();
  if (opts.building !== false) {
    const refused = await edition.beforeBuild(who.workspaceId);
    if (refused) throw new BuildRefused(refused);
  }
  const { context, message, images } = prompt.render(input);
  const jsonSchema = betaZodOutputFormat(prompt.schema).schema;
  const base: ProviderRequest = {
    prompt: `${prompt.name}@${prompt.version}`,
    model: modelFor(prompt.model),
    effort: prompt.effort,
    maxTokens: prompt.maxTokens,
    system: prompt.structured || prompt.answerTool ? prompt.system : `${prompt.system}\n\nThe JSON object follows this JSON Schema:\n${JSON.stringify(jsonSchema)}`,
    context,
    message,
    ...(images?.length ? { images } : {}),
    jsonSchema,
    structured: prompt.structured,
    ...(prompt.answerTool ? { answerTool: true } : {}),
  };

  let retry: ProviderRequest["retry"];
  for (const attempt of [1, 2]) {
    const res = await provider().call({ ...base, retry });
    const log = (passed: boolean, problem?: string) =>
      logCall(who, { prompt: prompt.name, version: prompt.version, model: res.model, usage: res.usage, ms: res.ms, attempt, passed, problem });
    if (res.stop !== "done") {
      const why = res.stop === "refused" ? "The model declined." : "The answer was too long.";
      await log(false, why);
      console.warn(`AI: ${prompt.name}@${prompt.version} stopped: ${why}`);
      throw new AiError(TRY_AGAIN);
    }
    const problems = await problemsWith(prompt, res.text, opts.check);
    await log(!problems.length, problems.join(" ") || undefined);
    if (!problems.length) return prompt.schema.parse(filled(prompt, unwrapped(prompt, JSON.parse(jsonIn(res.text)), fieldsOf(prompt.schema))));
    retry = { answer: withoutToolCalls(res.text), problems };
  }
  // Also in the server log, so a failed answer explains itself without the database (found live on Nov 3).
  console.warn(`AI: ${prompt.name}@${prompt.version} failed twice: ${(retry?.problems ?? []).join(" | ").slice(0, 1000)}`);
  throw new AiError(TRY_AGAIN, retry?.problems ?? []);
}

async function problemsWith<O>(prompt: Prompt<unknown, O>, text: string, check?: Check<O>): Promise<string[]> {
  let json: unknown;
  try {
    json = JSON.parse(jsonIn(text));
  } catch {
    return ["The answer wasn't JSON."];
  }
  const parsed = prompt.schema.safeParse(filled(prompt, unwrapped(prompt, json, fieldsOf(prompt.schema))));
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join(".") || "answer"}: ${i.message}`);
  return check ? await check(parsed.data) : [];
}

const filled = (prompt: Prompt<unknown, unknown>, json: unknown) => (prompt.fill ? prompt.fill(json) : json);

// An answer given through the answer tool, sometimes wrapped once under a name that isn't one of its fields
// ({"input": {...}}, {"json": {...}}; S1's recordings): the object inside is the answer.
export function unwrapped(prompt: { answerTool?: true }, json: unknown, fields: string[]): unknown {
  if (!prompt.answerTool || !json || typeof json !== "object" || Array.isArray(json)) return json;
  const [key, ...more] = Object.keys(json);
  const inner = key === undefined ? undefined : (json as Record<string, unknown>)[key];
  return key !== undefined && !more.length && !fields.includes(key) && inner && typeof inner === "object" && !Array.isArray(inner) ? inner : json;
}

// The top-level fields of an answer's schema (an object's), so a wrapper is told from a field.
const fieldsOf = (schema: unknown): string[] => {
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  return shape && typeof shape === "object" ? Object.keys(shape) : [];
};

// An answer as it goes back for a retry, without tool-call text the model wrote though it has no tools (S1: the
// planner began most answers with <invoke …>), so the next answer doesn't learn from it.
export function withoutToolCalls(text: string): string {
  const left = text.replace(/<invoke\b[\s\S]*?<\/invoke>/g, "").trim();
  return left || "(no answer)";
}

// The JSON object in an answer, without a code fence or words around it.
function jsonIn(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}
