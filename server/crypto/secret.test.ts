import { describe, expect, it } from "vitest";
import { seal, SealBroken, unseal } from "./secret";

describe("a sealed secret", () => {
  it("reads back with the same secret and purpose, and is never the same twice", () => {
    const a = seal("sk-ant-api03-abc", "ai-key", "s1");
    expect(unseal(a, "ai-key", "s1")).toBe("sk-ant-api03-abc");
    expect(seal("sk-ant-api03-abc", "ai-key", "s1")).not.toBe(a);
    expect(a).not.toContain("sk-ant");
  });

  it("is refused with another SESSION_SECRET or purpose, and when changed", () => {
    const a = seal("sk-ant-api03-abc", "ai-key", "s1");
    expect(() => unseal(a, "ai-key", "s2")).toThrow(SealBroken);
    expect(() => unseal(a, "other", "s1")).toThrow(SealBroken);
    const parts = a.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => unseal(parts.join("."), "ai-key", "s1")).toThrow(SealBroken);
    expect(() => unseal("plain", "ai-key", "s1")).toThrow(SealBroken);
  });
});
