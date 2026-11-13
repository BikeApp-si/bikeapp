import { z } from "zod";
import type { OntologyInput } from "@/server/kernel/ontology";
import { type Prompt } from "../prompt";
import { PLAIN_WORDS } from "./shared";

// Version 2 (M32): says "app" for what it called a capability, in its own words and in every word it writes for people.
// Prompt 6, the Ontology writer (developer notes §8). How the company runs, from each capability's Customize
// text and the kernel's counts: an opening paragraph, 5–8 paragraphs on how it fits together, one sentence
// per capability, one phrase per connection, and up to 3 things worth a look. The kernel checks every
// capability, connection and number; what doesn't pass is never shown (the page reads from the files).

export type OntologyWriterInput = OntologyInput & { previous: { intro: string; paragraphs: string[] } | null };

export const ontologyOutput = z.object({
  // "Fernwood is a 14-person software company. It runs 6 capabilities on Bike: hiring, onboarding, … Each one
  // is a set of sheets, the steps a row moves through, and who can see and do what."
  intro: z.string().min(1),
  paragraphs: z.array(z.string().min(1)).min(1).max(8),
  // One per capability, by its exact name: what it holds and who does what, in one or two short sentences.
  sentences: z.array(z.object({ capability: z.string(), sentence: z.string().min(1) })),
  // One per connection, by its key: a short phrase, no capital, no full stop ("when someone is hired, their
  // first week is planned").
  phrases: z.array(z.object({ connection: z.string(), phrase: z.string().min(1) })),
  // Up to 3: data gaps (empty columns, people without a manager), rules that disagree, gaps between capabilities.
  worth: z.array(z.string()).max(3),
});
export type OntologyOutput = z.infer<typeof ontologyOutput>;

const SYSTEM = `You write how a company runs, from its app texts. Readers are managers and staff, not engineers. Use plain, professional language: short sentences, no metaphors, no jargon beyond the app names.

- intro: one paragraph: what the company is (from what_it_does; when it is empty, just its name), how many people, and the apps it runs on Bike, then "Each one is a set of sheets, the steps a row moves through, and who can see and do what." Never say that something is missing or not filled in.
- paragraphs: 5–8 paragraphs in this order: People and reporting lines; the employee lifecycle (hiring, onboarding, tools); spending and approvals; revenue (contracts, renewals); time off (mention the public holidays when stats has them); what runs by itself and how decisions reach people. Skip a paragraph when its apps don't exist. Start each paragraph with a sentence about the company, never with a label naming its topic ("People and reporting lines." is wrong). End with "Every change, made by hand or through Customize, is recorded in the Audit log."
- sentences: one for each app, by its exact name: what it holds and who does what.
- phrases: one for each connection, by its key: a short phrase in lower case with no full stop, saying what happens across ("when someone is hired, their first week is planned").
- worth: up to 3 things worth a look, each one sentence that says why it matters: data gaps (stats.gaps, stats.without_manager), rules that disagree across apps, gaps between apps. None when there are none.

Use only facts in the app texts and stats. Name the people, amounts and counts given; never invent a rule, threshold, number or person. No headings, lists, tables or diagrams. Keep wording close to the previous version where nothing changed.
${PLAIN_WORDS}

Answer with the JSON object only.`;

export const ontologyWriter: Prompt<OntologyWriterInput, OntologyOutput> = {
  name: "ontology-writer",
  version: 2,
  model: "large",
  effort: "medium",
  maxTokens: 8000,
  structured: false,
  system: SYSTEM,
  schema: ontologyOutput,
  render(i) {
    const context = JSON.stringify({
      company: { name: i.company.name, what_it_does: i.company.whatItDoes, people: i.company.people, teams: i.company.teams },
      capabilities: i.capabilities.map((c) => ({ name: c.name, version: c.version, rows: c.rows, owner: c.owner, text: c.text })),
    });
    const message = [
      `Connections (key, from, to, what the rule says):\n${JSON.stringify(i.connections.map((c) => ({ key: c.key, from: c.from, to: c.to, rule: c.reading })))}`,
      `Stats:\n${JSON.stringify({ rules: i.stats.rules, without_manager: i.stats.withoutManager, holidays: i.stats.holidays, gaps: i.stats.gaps })}`,
      // Only when the company has any (0.2): a company without company rules is asked exactly as before.
      i.companyRules?.length ? `Company rules (one policy each, applied across the apps named; mention them where they shape how work runs):\n${JSON.stringify(i.companyRules)}` : "",
      i.previous ? `Previous version:\n${JSON.stringify(i.previous)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return { context, message };
  },
};
