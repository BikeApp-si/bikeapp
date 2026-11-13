import { describe, expect, it } from "vitest";
import { sameJson } from "./same-json";

describe("sameJson", () => {
  it("ignores key order, as jsonb gives it back, but not array order or values", () => {
    expect(sameJson({ a: 1, b: { c: [1, { d: 2, e: 3 }] } }, { b: { c: [1, { e: 3, d: 2 }] }, a: 1 })).toBe(true);
    expect(sameJson({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
  });
});
