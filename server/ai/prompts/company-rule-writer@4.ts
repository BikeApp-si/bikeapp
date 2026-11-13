import { z } from "zod";
import { draftRule } from "@/server/kernel/plans/draft";
import type { Prompt } from "../prompt";
import { BUILDING_BLOCKS, EXPRESSIONS, PLAIN_WORDS } from "./shared";

// Version 4 (S1): answers by calling one tool, "answer"; a policy that names what it covers applies only to those (version 3
// added Purchases to "Expenses and contracts").
// Version 3 (S1): says it has no tools and the answer is the JSON object as plain text; 3 of 4 answers of version 2 began with
// tool-call text (<invoke …>), and structured outputs refuse this schema (29 nullable fields, 16 allowed).
// Version 2 (M32): says "app" for what it called a capability, in its own words and in every word it writes for people.
// The company rule writer (0.2, M14): an admin's policy for the whole company, in plain words, becomes one company
// rule with a part on every capability sheet it fits, each part an ordinary rule written by name. It can also
// change or remove a company rule, or ask one question. The kernel compiles every part against its capability,
// checks it and replays it on past rows; the AI never decides what a rule would have done.

export type CompanyRuleInput = {
  company: { name: string; timeZone: string };
  capabilities: Record<string, unknown>[]; // every capability by name (structure.ts)
  people: { name: string; email: string; title: string | null }[];
  rules: { id: string; text: string; applies_to: string[] }[]; // the company rules now
  conversation: { from: "person" | "bike"; text: string }[];
  request: string;
};

export const companyRuleOutput = z.object({
  // add: a new company rule. change: a rule in `rules`, rewritten as a whole. remove: a rule in `rules`.
  // clarify: one question, with choices. refuse: something a company rule can't be (a change to one capability's
  // own setup, rows to edit), said plainly.
  type: z.enum(["add", "change", "remove", "clarify", "refuse"]),
  rule_id: z.string().nullable(), // for change and remove: the id from `rules`
  reply: z.string(), // one or two plain sentences, shown above the preview
  text: z.string().nullable(), // the policy as one sentence ("Expenses and contracts over $10,000 need Lena's approval.")
  when: z.string().nullable(), // a plain reading of the whole rule
  then: z.string().nullable(),
  // One part per capability sheet the policy fits, each a rule on that sheet; empty for remove, clarify, refuse.
  parts: z.array(draftRule),
  could_not: z.array(z.object({ where: z.string(), reason: z.string() })),
  clarify: z.object({ options: z.array(z.string()) }).nullable(),
});
export type CompanyRuleOutput = z.infer<typeof companyRuleOutput>;

const SYSTEM = `You write company rules for Bike: one policy for the whole company that applies across its apps. The kernel runs each part the same way every time; you only write them.

${BUILDING_BLOCKS}

${EXPRESSIONS}

How to write a company rule:
- Find every app sheet the policy fits, and write one part for each: a rule on that sheet, written by name, exactly as an app's own rule would be. Apply a policy only where it truly fits: "anything over $10,000" fits sheets with a money column for what is spent or committed; it doesn't fit sheets without one.
- When the policy names what it covers ("expenses and contracts"), apply it only to those sheets, not to others it would also fit; name those in the reply instead. Find every sheet it fits only when it names none ("anything over $10,000").
- Each part has capability and sheet (where its trigger is), trigger, condition and actions, with every field present (unused fields null or empty). Its text, when and then describe that part.
- When the policy asks someone to act on a row (approve, decide, check), use ask_person, so the row waits on them under Waiting on me; add a notify only when they should also get an email now. notify alone only informs.
- Never invent a column, step, app or person that isn't in the apps and people given. A sheet the policy should fit but can't be expressed on goes in could_not with the reason.
- text: the policy as one sentence. when / then: a plain reading of the whole rule ("An expense or a contract over $10,000 is added" / "It waits on Lena to approve it").
- To change a rule, give its rule_id from the rules given and write it again in full. To remove one, give its rule_id and no parts.
- When the request is unclear in a way that changes the rule (whose approval, which amount), ask one question with two to four choices (type clarify).
- A request about one app's own setup, or about rows, isn't a company rule: refuse, and say where it is done (that app's Customize, or its Data tab).
- reply: one or two plain sentences for the admin, saying where it applies.

${PLAIN_WORDS}

Give your answer by calling the answer tool once, with the JSON object as its input. Write nothing else.`;

export const companyRuleWriter: Prompt<CompanyRuleInput, CompanyRuleOutput> = {
  name: "company-rule-writer",
  version: 4,
  answerTool: true,
  model: "large",
  effort: "high",
  maxTokens: 32000,
  structured: false,
  system: SYSTEM,
  schema: companyRuleOutput,
  render(i) {
    const context = JSON.stringify({ company: i.company, people: i.people, capabilities: i.capabilities }, null, 1);
    const message = `Company rules now:\n${JSON.stringify(i.rules, null, 1)}\n\nConversation so far:\n${JSON.stringify(i.conversation, null, 1)}\n\nRequest:\n${i.request}`;
    return { context, message };
  },
};
