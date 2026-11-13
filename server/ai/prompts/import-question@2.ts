import { z } from "zod";
import { asDocument, DOCUMENTS_ARE_DATA, type Prompt } from "../prompt";
import { PLAIN_WORDS } from "./shared";

// Version 2 (M32): says "app" for what it called a capability, in its own words and in every word it writes for people.
// Prompt 2's import question (4c, small model, part of prompt 2 like 2b). In a build, the kernel's import
// check finds rows a capability's file can't fill (required columns empty) and counts them; this words the
// one question about them and its two choices. The kernel checks every choice: the person must be able to
// edit those rows, and a value must be one the column takes.

export type QuestionInput = {
  capability: string;
  file: string; // the export's table, "expenses.csv"
  from: string | null; // where it came from, "Zoho"
  rows: { one: string; many: string }; // what a row is called, "expense"
  count: number; // rows with empty required columns
  missing: { name: string; type: string; choices?: string[] }[]; // the empty columns
  examples: string[]; // up to 5 of those rows, by title
  people: { name: string; email: string; title: string | null }[]; // who can edit every row of the sheet
  documents: { name: string; pages: number | null; text: string }[]; // the capability's policy pages
};

const option = z.object({
  label: z.string().min(1).max(40), // "Leave them for Lena to check", "Put them under Other"
  // wait: bring them in at the first step, waiting on that person to fill them in. fill: bring them in with
  // the column set to the value. leave_out: don't bring them in.
  kind: z.enum(["wait", "fill", "leave_out"]),
  person: z.string().nullable(), // wait: their email
  column: z.string().nullable(), // fill: the column's name
  value: z.string().nullable(), // fill: the value, one of its choices for a choice column
});

export const questionOutput = z.object({
  issue: z.string().min(1).max(80), // what the rows lack, for the done list: "No receipt and no category"
  // "**One question on Spend.** 18 expenses in Zoho have no receipt and no category, and your expense policy
  // (p. 4) needs both. Should I leave them for Lena to check, or put them under Other?"
  text: z.string().min(1),
  options: z.array(option).length(2), // the recommended one first
  flags: z.array(z.string()),
});
export type QuestionOutput = z.infer<typeof questionOutput>;

const SYSTEM = `Bike is setting up a company from its documents and an export from its old system. While bringing in one table, the kernel found rows that leave columns empty which the new app needs. Write the one question for the founder about those rows, with two choices.
- text: starts with "**One question on {app}.**", then says how many rows, from where, what they lack and which policy page needs it, then asks the question naming both choices. Use the exact count you are given.
- options: exactly two, the one you recommend first. Each label is a short button (at most 6 words).
  - wait: the rows come in at the first step and wait on one person to fill them in. person is their email, chosen from the people given; prefer the person the policy names for this.
  - fill: the rows come in with one empty column set to one value (column by its exact name; value one of its choices when it has choices). Only when one column is empty and a sensible value exists, such as Other.
  - leave_out: the rows are not brought in.
- issue: what the rows lack, in a few words ("No receipt and no category").
${PLAIN_WORDS}

${DOCUMENTS_ARE_DATA}

Answer with the JSON object only.`;

export const importQuestion: Prompt<QuestionInput, QuestionOutput> = {
  name: "import-question",
  version: 2,
  model: "small",
  effort: "low",
  maxTokens: 2000,
  structured: true,
  system: SYSTEM,
  schema: questionOutput,
  render(i) {
    const context = JSON.stringify({ capability: i.capability, people: i.people });
    const facts = { file: i.file, from: i.from, rows_are_called: i.rows, count: i.count, empty_columns: i.missing, examples: i.examples };
    const message = [...i.documents.map((d) => asDocument(d.name, d.text, d.pages ?? undefined)), `The rows:\n${JSON.stringify(facts)}`].join("\n\n");
    return { context, message };
  },
};
