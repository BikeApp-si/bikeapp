import { beforeAll, describe, expect, it } from "vitest";
import { kernelWorkspace } from "@/tests/kernel";
import { checkCoherence, readCoherence, saveCoherence, worthALook } from "./coherence";
import type { OntologyInput } from "./ontology";

// The coherence check's kernel side: items name real capabilities and only numbers their texts have; one
// current result per workspace, saved by an admin; on 4e they come first, at most 5 in all.

const input = {
  capabilities: [
    { name: "Spend", text: "What happens by itself: A purchase over $2,000 goes to Krishna to approve." },
    { name: "Tools and budgets", text: "What happens by itself: Lena may renew a vendor up to $5,000." },
  ],
} as unknown as OntologyInput;

describe("the coherence check", () => {
  it("accepts items about real apps with numbers from their texts", () => {
    const items = [{ text: "Spend sends purchases over $2,000 to Krishna, but Tools and budgets lets Lena renew up to $5,000 without him.", capabilities: ["Spend", "Tools and budgets"] }];
    expect(checkCoherence(items, input)).toEqual([]);
  });

  it("refuses an app that isn't there and an invented amount", () => {
    const problems = checkCoherence([{ text: "Payroll pays over $9,000.", capabilities: ["Payroll"] }], input).join("\n");
    expect(problems).toContain('"Payroll" isn\'t an app');
    expect(problems).toContain("9000 isn't in the app texts");
  });

  it("comes first in Worth a look, at most 5 in all", () => {
    expect(worthALook([{ text: "A", capabilities: [] }, { text: "B", capabilities: [] }], ["c", "d", "e", "f"])).toEqual(["A", "B", "c", "d", "e"]);
  });
});

describe("the stored result", () => {
  let k: Awaited<ReturnType<typeof kernelWorkspace>>;
  beforeAll(async () => {
    k = await kernelWorkspace();
  });

  it("is one current result, saved again in place, by an admin only", async () => {
    await k.as("ada", (tx, c) => saveCoherence(tx, c, "h1", [{ text: "A", capabilities: ["Spend"] }]));
    await k.as("ada", (tx, c) => saveCoherence(tx, c, "h2", []));
    expect(await k.as("ada", (tx) => readCoherence(tx))).toMatchObject({ inputHash: "h2", items: [] });
    await expect(k.as("maya", (tx, c) => saveCoherence(tx, c, "h3", []))).rejects.toThrow();
  });
});
