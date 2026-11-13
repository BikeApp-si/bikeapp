import { describe, expect, it } from "vitest";
import { answerOf, stopOf } from "./anthropic";

describe("how an answer stopped", () => {
  it("a cut-off answer is too long, a refusal is refused, the rest are done", () => {
    expect(stopOf("max_tokens")).toBe("too_long");
    expect(stopOf("refusal")).toBe("refused");
    expect(stopOf("end_turn")).toBe("done");
    expect(stopOf(null)).toBe("done");
  });
});

describe("the answer's text (S1)", () => {
  it("is the answer tool's input when the model called it, else its text", () => {
    expect(answerOf([{ type: "thinking" }, { type: "text", text: "Here it is." }, { type: "tool_use", name: "answer", input: { said: "hi" } }])).toBe('{"said":"hi"}');
    expect(answerOf([{ type: "text", text: '{"said":' }, { type: "text", text: '"hi"}' }])).toBe('{"said":"hi"}');
  });
});
