// What each call costs, in US dollars per million tokens, from Anthropic's price list (Oct 2026). Cache
// writes are 1.25 × input and cache reads 0.1 × input where the list gives no figure of its own. Opus is here
// so the designer can be compared on it later; it isn't used in 0.1.

type Price = { input: number; output: number; cacheRead: number; cacheWrite: number; overInput?: { above: number; input: number; output: number } };

export const PRICES: Record<string, Price> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  // Above 100K tokens of input, Haiku 5.5 costs $0.50 / $2.50.
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, overInput: { above: 100_000, input: 0.5, output: 2.5 } },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

export type Usage = { tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number };

// A call's cost. A model not on the list costs nothing here and says so in the log (cost 0).
export function costOf(model: string, u: Usage): number {
  const p = PRICES[model];
  if (!p) return 0;
  const prompt = u.tokensIn + u.cacheRead + u.cacheWrite;
  const big = p.overInput && prompt > p.overInput.above ? p.overInput : null;
  const input = big?.input ?? p.input;
  const scale = input / p.input;
  const dollars =
    u.tokensIn * input + u.tokensOut * (big?.output ?? p.output) + u.cacheRead * p.cacheRead * scale + u.cacheWrite * p.cacheWrite * scale;
  return dollars / 1_000_000;
}
