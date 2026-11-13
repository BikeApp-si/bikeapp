import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Provider, ProviderRequest, ProviderResponse } from "./types";
import { NoModel } from "../errors";
import { aiKey } from "@/server/kernel/instance-settings";

// Anthropic's API. The answer is JSON in the prompt's schema (structured outputs). The system prompt and the
// context are marked for caching, so a chat's later messages reuse them. On Sonnet, a refused request is run
// again server-side on the model Anthropic recommends for that kind of refusal; Haiku has no such fallback.

// The company's key (Settings › AI, else .env), one client per key. The key is never part of the request, so
// recorded answers stay the same whichever key made them.
let client: { key: string; sdk: Anthropic } | null = null;
async function anthropic(): Promise<Anthropic> {
  const k = await aiKey();
  if (!k) throw new NoModel();
  if (client?.key !== k.key) client = { key: k.key, sdk: new Anthropic({ apiKey: k.key }) };
  return client.sdk;
}

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const hasFallback = (model: string) => model.startsWith("claude-sonnet-");

export function messagesFor(req: ProviderRequest): BetaMessageParam[] {
  const first: BetaMessageParam = {
    role: "user",
    content: [
      { type: "text", text: req.context, cache_control: { type: "ephemeral" } },
      ...(req.images ?? []).map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.mediaType, data: i.data } })),
      { type: "text", text: req.message },
    ],
  };
  if (!req.retry) return [first];
  return [
    first,
    { role: "assistant", content: req.retry.answer },
    {
      role: "user",
      content: `Bike couldn't use that answer:\n${req.retry.problems.map((p) => `- ${p}`).join("\n")}\nAnswer again in the same shape, fixing these. Write every sentence a person reads as if this were your first answer: never mention this correction.`,
    },
  ];
}

// The answer's text: the input of the answer tool when the model called it (S1), else its text.
export function answerOf(content: { type: string; name?: string; input?: unknown; text?: string }[]): string {
  const call = content.find((b) => b.type === "tool_use" && b.name === ANSWER_TOOL);
  if (call) return JSON.stringify(call.input);
  return content.flatMap((b) => (b.type === "text" ? [b.text ?? ""] : [])).join("");
}

export const ANSWER_TOOL = "answer";

export function stopOf(reason: string | null): ProviderResponse["stop"] {
  return reason === "refusal" ? "refused" : reason === "max_tokens" ? "too_long" : "done";
}

export const anthropicProvider: Provider = {
  async call(req) {
    const started = Date.now();
    const fallback = hasFallback(req.model);
    // Streamed, then read whole: a long answer (a big capability's design, up to 32,000 tokens) isn't cut off by
    // the time limit the SDK puts on requests that aren't streamed.
    const res = await (await anthropic()).beta.messages.stream({
      model: req.model,
      max_tokens: req.maxTokens,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: messagesFor(req),
      output_config: { effort: req.effort, ...(req.structured ? { format: { type: "json_schema" as const, schema: req.jsonSchema } } : {}) },
      ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
      ...(req.answerTool
        ? { tools: [{ name: ANSWER_TOOL, description: "Give your answer: the JSON object, as this tool's input.", input_schema: req.jsonSchema as { type: "object" } }], tool_choice: { type: "auto" as const } }
        : {}),
    }).finalMessage();
    const text = answerOf(res.content);
    const stop = stopOf(res.stop_reason);
    return {
      model: res.model,
      text,
      stop,
      usage: {
        tokensIn: res.usage.input_tokens,
        tokensOut: res.usage.output_tokens,
        cacheRead: res.usage.cache_read_input_tokens ?? 0,
        cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
      },
      ms: Date.now() - started,
    };
  },
};
