import { describe, expect, it } from "vitest";
import { bigFile, PEOPLE } from "@/server/kernel/fixtures";
import { customizeDescription } from "@/server/kernel/customize/context";
import { describeCapability } from "@/server/kernel/plans/structure";
import { renderCapabilityText } from "@/server/kernel/render-text";
import { LIMITS, validateFile } from "@/server/kernel/schema/validate";
import type { CapabilityFile } from "@/server/kernel/schema/file";
import type { Prompt } from "../prompt";
import { capabilityDesigner } from "./capability-designer@11";
import { customizeAdvisor } from "./customize-advisor@2";
import { customizeGuide } from "./customize-guide@2";
import { customizePlanner } from "./customize-planner@12";
import { logicWriter } from "./logic-writer@7";

// M25: a capability at every limit still fits what the prompts that read a whole capability are sent. The Ontology
// writer and the tutorial writer read summaries, smaller than these. Tokens are
// estimated at 3 characters each (JSON runs denser than prose), so the budget errs on the safe side.
const BUDGET = 60_000;
const tokens = (s: string) => Math.ceil(s.length / 3);
const sent = <I>(p: Prompt<I, unknown>, input: I) => {
  const r = p.render(input);
  return tokens(p.system) + tokens(r.context) + tokens(r.message);
};

const ID = "20000000-0000-4000-8000-000000000001";
const big = bigFile();
const files = new Map<string, CapabilityFile>([[ID, big]]);
const personName = (id: string) => (id === PEOPLE.wade ? "Wade Wilson" : undefined);
const text = JSON.stringify(renderCapabilityText(big, { capId: ID, files, personName, viewerId: null }));
const user = { name: "Wade Wilson", email: "wade@fernwood.dev" };
const company = { name: "Fernwood Labs", currency: "USD", timeZone: "America/Chicago" };
const conversation = [{ from: "person" as const, text: "Add a sibling discount" }];

describe("a capability at every limit", () => {
  it("is the limits, and the kernel accepts it", () => {
    expect(big.sheets).toHaveLength(LIMITS.sheets);
    expect(big.sheets.every((s) => s.columns.length === LIMITS.columns)).toBe(true);
    expect(big.rules).toHaveLength(LIMITS.rules);
    const check = validateFile(big, { people: new Set(Object.values(PEOPLE)) });
    expect(check.ok ? [] : check.errors).toEqual([]);
  });

  it("renders its Customize text, every sheet in it", () => {
    for (const s of big.sheets) expect(text).toContain(s.name);
  });

  it("fits the Customize planner, guide and advisor", () => {
    const capability = customizeDescription(ID, files, personName, { withForm: true, withAccess: true });
    const planner = sent(customizePlanner, { user, company, capability, text, connected: [], people: [], conversation, request: "Add a sibling discount" });
    const guide = sent(customizeGuide, { text, capability, access: {} as never, conversation, message: "How do fees work?" });
    const advisor = sent(customizeAdvisor, { text, capability, counts: [], others: [], room: 0, conversation, message: "What else should we track?" });
    for (const n of [planner, guide, advisor]) expect(n).toBeLessThan(BUDGET);
  });

  it("fits the capability designer and the logic writer with six such capabilities already in the company", () => {
    const six = new Map(Array.from({ length: 6 }, (_, i) => [`2000000${i}-0000-4000-8000-000000000001`, { ...big, name: `Admissions ${i + 1}` }] as const));
    const existing = [...six.keys()].map((id) => describeCapability(id, six, personName));
    const designer = sent(capabilityDesigner, { user, company: { ...company, people: 50 }, existing, people: [], conversation, currentPlan: null, latestMessage: "Track transport", documents: [], tables: [] });
    // Prompt 4 reads every capability by name too, with 20 sentences to turn into rules.
    const logic = sent(logicWriter, { company, capabilities: existing, people: [], sentences: big.rules.map((r) => r.text) });
    // Measured Nov 6: planner, guide and advisor about 12k–14k; the designer and logic writer about 21k.
    for (const n of [designer, logic]) expect(n).toBeLessThan(BUDGET);
  });
});
