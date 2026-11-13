import { z } from "zod";
import { BIKE_GUIDE } from "@/server/ai/guide/bike-guide";
import { customizeChange, fillChange } from "@/server/kernel/customize/draft";
import type { AccessSummary } from "@/server/kernel/access-summary";
import type { Prompt } from "../prompt";
import { CHANGES_TEXT } from "./customize-planner@9";
import { BUILDING_BLOCKS, EXPRESSIONS, PLAIN_WORDS } from "./shared";

// Version 2 (M32): says "app" for what it called a capability, in its own words and in every word it writes for people.
// Prompt 10, the Customize guide (C2, small model). Answers "how do I…", "why can't I…", "what does this mean" and
// "can Bike do…" for one capability, and turns a refusal into teaching: the reason in plain words and requests that
// work. It changes nothing. Each suggested request comes with its changes, so the kernel checks it before it becomes
// a button; pressing one sends the request to the planner (prompt 3) as the admin's next message. It answers only from
// the Bike guide (first, so it's cached), the capability's text and the admin's access: it never invents a feature.

export type GuideInput = {
  text: string; // the capability as the Customize text reads, headings and lines
  capability: Record<string, unknown>; // by name, with its roles and how each sees each sheet (customize/context.ts)
  access: AccessSummary; // what the admin can do here
  conversation: { from: "person" | "bike"; text: string }[]; // the last few turns
  message: string;
  refusal?: string; // why Bike couldn't make the change just asked for, in plain words
};

export const guideOutput = z.object({
  // Paragraphs, or numbered steps ("1. …") when they asked how; plain words, no markdown beyond the numbers.
  answer: z.string().min(1).max(1500),
  table: z.object({ columns: z.array(z.string().min(1)).min(2).max(4), rows: z.array(z.array(z.string())).min(1).max(8) }).nullable(),
  // The heading of the capability's text the answer is about ("Who can see and do what"), exactly as it reads.
  section: z.string().nullable(),
  // Up to three requests the admin could send next, each with the changes it would make; only ones that would apply.
  suggestions: z.array(z.object({ label: z.string().min(1).max(100), changes: z.array(customizeChange).min(1) })).max(3),
  // True when Bike can't do what they asked; the answer then says so once, with the nearest it can do.
  cant: z.boolean(),
});
export type GuideOutput = z.infer<typeof guideOutput>;

const SYSTEM = `You explain one app in Bike to its admin, in the app's Customize chat. You change nothing: you answer, and you offer up to three requests the admin can send next. Answer only from the Bike guide below, the app's text and the admin's access; never say Bike can do something the guide doesn't say it can. If it can't, set "cant" and say so in the answer, with the nearest it can do.

${BIKE_GUIDE}

How you answer:
1. "How do I …", "tell me the steps": numbered steps ("1. …"), each one thing the admin does in Bike, with the app's own names. Asking Customize in words is a step ("Ask here: \\"Add a Companies sheet with an Owner\\""), and the Data tab is where values and owners change.
2. "Why …", "what does … mean": two to four sentences, with the app's own names, and the part of its text it's about in "section" (a heading exactly as it reads, or null).
3. When a refusal is given: start with why, in plain words, then what would work.
4. suggestions: requests in the admin's own words ("Add a Companies sheet with an Owner"), at most three, each with its changes in the shape below. Only what this version can apply; Bike checks each and drops any that wouldn't. None when nothing fits.
5. A table only when it helps (who sees which sheet), at most 4 columns.
6. When Bike can't do what they asked, set "cant" to true and say so once in the answer: one sentence why, one with the nearest it can do.
7. What the app does today is only what its text says: a rule is set up only if "What happens by itself" lists it, a sheet or question only if the text has it. Something Bike could do but this app doesn't yet is a suggestion, never "works here today".
8. Answer this message as it stands; never mention or correct an earlier reply.

The changes behind a suggestion, by name (as the change planner writes them):
${BUILDING_BLOCKS}

${EXPRESSIONS}

${CHANGES_TEXT}

${PLAIN_WORDS}

Answer with the JSON object only.`;

export const customizeGuide: Prompt<GuideInput, GuideOutput> = {
  name: "customize-guide",
  version: 2,
  model: "small",
  effort: "low",
  maxTokens: 4000,
  structured: false,
  // The small model often leaves a change's unused fields out, or its Part null (M29): filled in before the check.
  fill: (json) => {
    if (!json || typeof json !== "object" || !Array.isArray((json as { suggestions?: unknown }).suggestions)) return json;
    const j = json as { suggestions: { changes?: unknown }[] };
    return { ...j, suggestions: j.suggestions.map((sg) => (sg && Array.isArray(sg.changes) ? { ...sg, changes: sg.changes.map(fillChange) } : sg)) };
  },
  system: SYSTEM,
  schema: guideOutput,
  render(i) {
    const context = JSON.stringify({ capability: i.capability, your_access: i.access }, null, 1);
    const turns = i.conversation.map((m) => `${m.from === "person" ? "Admin" : "Bike"}: ${m.text}`).join("\n");
    const message = [
      `How it reads now:\n${i.text}`,
      turns ? `The chat so far:\n${turns}` : "",
      i.refusal ? `Bike couldn't make the change just asked for: ${i.refusal}` : "",
      `Latest message:\n${i.message}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    return { context, message };
  },
};
