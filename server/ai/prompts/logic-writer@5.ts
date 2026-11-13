import { z } from "zod";
import { draftRule } from "@/server/kernel/plans/draft";
import type { Prompt } from "../prompt";
import { LOGIC_EXAMPLE } from "./examples";
import { BUILDING_BLOCKS, EXPRESSIONS, PLAIN_WORDS } from "./shared";

// Prompt 4, the logic writer (developer notes §8). Version 5 (M29): ledgers and balanceOf, through the shared text. Version 3 adds date rules from the day a row was added and
// the row itself in a field map (6f, 6g). Plain sentences → rules in the kernel's schema, written by
// name, each with a plain When / Then reading. The kernel checks them and replays them on past rows; the AI
// never works out what a rule would have done.

export type LogicInput = {
  company: { name: string; timeZone: string }; // no date, as in prompt 2
  capabilities: Record<string, unknown>[]; // every capability by name, the new one first (structure.ts)
  people: { name: string; email: string; title: string | null }[];
  sentences: string[];
};

export const logicOutput = z.object({
  rules: z.array(draftRule),
  // A sentence the building blocks can't express, and why, in plain words. It isn't built.
  could_not: z.array(z.object({ sentence: z.string(), reason: z.string() })),
});
export type LogicOutput = z.infer<typeof logicOutput>;

const SYSTEM = `You turn sentences about how a company works into rules Bike's kernel runs. The kernel runs them the same way every time; you only write them. Write one rule per sentence when you can (two when one sentence needs two triggers), in the order given.

${BUILDING_BLOCKS}

${EXPRESSIONS}

How to write a rule:
- capability and sheet: where the rule's trigger is. trigger.step, field and date are names on that sheet. A date rule counts from a date column (offset_days negative for "before"), or from the day the row was added: from_added true and date null ("14 days after it was added" is from_added with offset_days 14).
- condition: an expression that must hold for the rule to act, or null.
- actions, in order. Every action has every field; unused fields are null or empty.
  - When a sentence asks someone to act on a row (remind them, ask them, have them approve or decide), use ask_person: the row waits on them under Waiting on me and in their morning email, at a step (it moves there first) or until a column is filled. Add a notify when they should also get an email now. notify alone only informs: nothing waits on anyone.
  - "Ask X to approve" is ask_person with the person; with a decision only when the sheet has a choice column to record it.
  - update_row_in names the link column (via) on this sheet that points at the row to update; its map sets that row's columns (setting its step column moves it).
  - In a field map, {"ref":"row"} is the row that ran the rule itself, for a link column in the target sheet that points back at it ("add three interviews for the candidate": three create_row_in, each mapping Candidate to {"ref":"row"}).
  - When the sentence says what must hold for a move (within 2%), put that in the condition, and write the case where it doesn't hold as its own rule when the sentence says what happens then.
- text: the sentence as given. when / then: a plain reading ("60 days before a contract's notice date" / "It moves to Renewal due and its owner is reminded").
- A sentence you can't express: add it to could_not with the reason; never invent a column, step, capability or person that isn't in the capabilities given.

${PLAIN_WORDS}

An example. For these sentences about Customer contracts:
${LOGIC_EXAMPLE.sentences.map((s) => `- ${s}`).join("\n")}
the answer was:
${JSON.stringify(LOGIC_EXAMPLE.output)}

Answer with the JSON object only.`;

export const logicWriter: Prompt<LogicInput, LogicOutput> = {
  name: "logic-writer",
  version: 5,
  model: "large",
  effort: "high",
  maxTokens: 16000,
  structured: false,
  system: SYSTEM,
  schema: logicOutput,
  render(i) {
    const context = JSON.stringify({ company: i.company, people: i.people }, null, 1);
    const message = `Capabilities:\n${JSON.stringify(i.capabilities, null, 1)}\n\nSentences:\n${i.sentences.map((s, n) => `${n + 1}. ${s}`).join("\n")}`;
    return { context, message };
  },
};
