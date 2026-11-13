// Whether Anthropic takes a key, by listing its models: no AI call and no cost (Settings › AI, the health check).
export type KeyCheck = "ok" | "refused" | "error" | "unreachable";

export async function checkAnthropicKey(key: string, timeoutMs = 5_000): Promise<KeyCheck> {
  // Recorded answers only (tests and the replayed flows): nothing reaches Anthropic, so any key is taken.
  if (process.env.AI_PROVIDER === "fixtures") return "ok";
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return "ok";
    return res.status === 401 || res.status === 403 ? "refused" : "error";
  } catch {
    return "unreachable";
  }
}
