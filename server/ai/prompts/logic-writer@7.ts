import { z } from "zod";
import { draftRule } from "@/server/kernel/plans/draft";
import type { Prompt } from "../prompt";
import { LOGIC_EXAMPLE } from "./examples";
import { BUILDING_BLOCKS, EXPRESSIONS, PLAIN_WORDS } from "./shared";

// Version 7 (M32): rules that repeat on a schedule (trigger repeats, through the shared text and below), and "app" for
// what it called a capability, in its own words and in every word it writes for people.
// Prompt 4, the logic writer (developer notes §8). Version 6 (M30): sheets kept by date and inForce, through the shared text. Version 5 (M29): ledgers and balanceOf, through the shared text. Version 3 adds date rules from the day a row was added and
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
- A rule that repeats on a schedule ("every month on the 1st, add the office rent"): trigger kind repeats on the sheet it adds to, with every: {"unit":"week","weekday":"Monday","day":null,"month":null}, {"unit":"month","weekday":null,"day":1,"month":null} or {"unit":"year","weekday":null,"day":1,"month":3}; starts and ends a date ("2026-12-01") or null; step, field, date and offset_days null; condition null. Its actions are create_row_in into that same sheet only. Its map gives every value outright and fills every required column and the person column whoever adds it would fill: the person the sentence names; when it names nobody for that column, add the sentence to could_not saying who the rows are for. {"ref":"today"} in its map is the day the row is due.
  For "Every month on the 1st, add the office rent to Expenses: $2,400, Office, paid with the company card, for Wade.": {"capability":"Spend","sheet":"Expenses","trigger":{"kind":"repeats","step":null,"field":null,"date":null,"offset_days":null,"every":{"unit":"month","weekday":null,"day":1,"month":null},"starts":null,"ends":null},"condition":null,"actions":[{"kind":"create_row_in","target":{"capability":"Spend","sheet":"Expenses"},"map":[{"column":"What for","value":"\\"Office rent\\""},{"column":"Who","value":"\\"wade@fernwood.dev\\""},{"column":"Date","value":"{\\"ref\\":\\"today\\"}"},{"column":"Amount","value":"2400"},{"column":"Category","value":"\\"Office\\""},{"column":"Paid with","value":"\\"Company card\\""}], …every other field null or empty}], with its text, when ("Every month on the 1st") and then ("An expense is added: Office rent, $2,400, for Wade").
- condition: an expression that must hold for the rule to act, or null.
- actions, in order. Every action has every field; unused fields are null or empty.
  - When a sentence asks someone to act on a row (remind them, ask them, have them approve or decide), use ask_person: the row waits on them under Waiting on me and in their morning email, at a step (it moves there first) or until a column is filled. Add a notify when they should also get an email now. notify alone only informs: nothing waits on anyone.
  - "Ask X to approve" is ask_person with the person; with a decision only when the sheet has a choice column to record it.
  - update_row_in names the link column (via) on this sheet that points at the row to update; its map sets that row's columns (setting its step column moves it).
  - In a field map, {"ref":"row"} is the row that ran the rule itself, for a link column in the target sheet that points back at it ("add three interviews for the candidate": three create_row_in, each mapping Candidate to {"ref":"row"}).
  - When the sentence says what must hold for a move (within 2%), put that in the condition, and write the case where it doesn't hold as its own rule when the sentence says what happens then.
- text: the sentence as given. when / then: a plain reading ("60 days before a contract's notice date" / "It moves to Renewal due and its owner is reminded").
- A sentence you can't express: add it to could_not with the reason; never invent a column, step, app or person that isn't in the apps given.

${PLAIN_WORDS}

An example. For these sentences about Customer contracts:
${LOGIC_EXAMPLE.sentences.map((s) => `- ${s}`).join("\n")}
the answer was:
${JSON.stringify(LOGIC_EXAMPLE.output)}

Answer with the JSON object only.`;

export const logicWriter: Prompt<LogicInput, LogicOutput> = {
  name: "logic-writer",
  version: 7,
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
