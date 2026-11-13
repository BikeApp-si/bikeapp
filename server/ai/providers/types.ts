import type { Usage } from "../prices";
import type { Effort } from "../prompt";

// What the gateway asks a provider for: one call, already laid out (prompt.ts). Turns after the first are
// a retry: the answer that failed and the problems the kernel found.
export type ProviderRequest = {
  prompt: string; // name@version, for fixtures
  model: string;
  effort: Effort;
  maxTokens: number;
  system: string;
  context: string;
  message: string;
  retry?: { answer: string; problems: string[] };
  images?: { mediaType: "image/png" | "image/jpeg"; data: string }[]; // base64, sent after the context (a receipt photo)
  jsonSchema: Record<string, unknown>;
  structured: boolean; // hold the answer to jsonSchema (structured outputs); otherwise the system prompt carries it
  // S1: the answer comes as the input of one tool, "answer", whose schema is jsonSchema (a schema too large for
  // structured outputs, from a prompt that otherwise writes tool calls as text).
  answerTool?: boolean;
};

// The model's answer as JSON text, or why there is none.
export type ProviderResponse = {
  model: string; // the model that answered (a fallback may answer instead)
  text: string;
  stop: "done" | "refused" | "too_long";
  usage: Usage;
  ms: number;
};

export type Provider = { call(req: ProviderRequest): Promise<ProviderResponse> };
