import { z } from "zod";
import { type Prompt } from "../prompt";
import { companyWays, PLAIN_WORDS } from "./shared";
import type { Formats } from "@/lib/format";

// Prompt 7's sentence (developer notes §8, small model): one or two sentences from the result table only
// (at most 50 cells): the headline number, then what stands out. On Run again, what changed since the first
// run. The kernel checks every number in it is one the table gives.

export type SentenceInput = {
  question: string;
  title: string;
  today: string;
  how: string[];
  missing: string | null;
  table: { columns: string[]; rows: (string | number | null)[][]; totals: Record<string, number> };
  rowsRead: string; // "128 purchases"
  previous: { ranOn: string; table: { columns: string[]; rows: (string | number | null)[][]; totals: Record<string, number> } } | null;
  formats?: Formats; // how the company writes money and days (M26); said only when they aren't the defaults
};

export const sentenceOutput = z.object({ sentence: z.string().min(1).max(400) });
export type SentenceOutput = z.infer<typeof sentenceOutput>;

const SYSTEM = `You write the first line of a report's answer in Bike, from its result table only. One or two short sentences: the headline number, in **bold**, then what stands out (the highest, the one nearly over, a gap). Name the period the way how says it ("this quarter so far (Oct 1–26)").
- When missing is given, say it first as a plain sentence (no label such as "Missing:"), then answer for what there is.
- When previous is given, it is the same report run again: start "Ran again with data to {today as Oct 27}:", give the new headline number in bold, how it differs from the previous run ("$6,600 more than on Oct 26"), and the change that matters most.
- Use only numbers from the table, its totals and rows read, or plain differences and percents of them. Money as "$95,300", percents as "87%". No lists, no headings.
${PLAIN_WORDS}

Answer with the JSON object only.`;

export const reportSentence: Prompt<SentenceInput, SentenceOutput> = {
  name: "report-sentence",
  version: 1,
  model: "small",
  effort: "low",
  maxTokens: 800,
  structured: true,
  system: SYSTEM,
  schema: sentenceOutput,
  render(i) {
    return {
      context: [JSON.stringify({ question: i.question, title: i.title, how: i.how, missing: i.missing }), companyWays(i.formats, ["write"])].filter(Boolean).join("\n"),
      message: JSON.stringify({ today: i.today, rows_read: i.rowsRead, table: i.table, previous: i.previous }),
    };
  },
};
