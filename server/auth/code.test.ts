import { describe, expect, it } from "vitest";
import { CODE_ALPHABET, codeMatches, formatCode, hashCode, newCode, normalizeCode } from "./code";

describe("codes", () => {
  it("are 6 characters with no look-alikes", () => {
    for (let i = 0; i < 200; i++) {
      const c = newCode();
      expect(c).toMatch(/^[A-Z2-9]{6}$/);
      expect(c).not.toMatch(/[OIL01]/);
    }
    expect(CODE_ALPHABET).not.toMatch(/[OIL01]/);
  });
  it("show with a dash and read in any case, pasted or typed", () => {
    expect(formatCode("K7Q4W8")).toBe("K7Q-4W8");
    expect(normalizeCode(" k7q-4w8 ")).toBe("K7Q4W8");
  });
  it("are stored as a keyed hash that only matches the same email and code", () => {
    const h = hashCode("wade@fernwood.dev", "K7Q4W8");
    expect(h).not.toContain("K7Q4W8");
    expect(codeMatches(h, "wade@fernwood.dev", "k7q-4w8")).toBe(true);
    expect(codeMatches(h, "wade@fernwood.dev", "K7Q4W9")).toBe(false);
    expect(codeMatches(h, "maya@fernwood.dev", "K7Q4W8")).toBe(false);
  });
});
