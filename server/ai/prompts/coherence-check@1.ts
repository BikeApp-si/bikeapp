import { z } from "zod";
import { type Prompt } from "../prompt";
import { PLAIN_WORDS } from "./shared";

// Prompt 4's coherence mode (developer notes §8, 4): every capability's Customize text in, the gaps and
// contradictions across them out (a step nobody can move, a hand-off to something that isn't there, two rules
// that fight). They show on the Ontology under Worth a look. The kernel checks each names real capabilities
// and no number that isn't in their texts.

export type CoherenceInput = { capabilities: { name: string; text: string }[]; companyRules?: { text: string; appliesTo: string[] }[] };

export const coherenceOutput = z.object({
  items: z
    .array(
      z.object({
        // One sentence that says what disagrees or is missing, and why it matters: "Spend sends purchases over
        // $2,000 to Krishna, but Tools and budgets lets Lena renew a vendor up to $5,000 without him. The two
        // rules disagree."
        text: z.string().min(1),
        capabilities: z.array(z.string()).min(1), // the capabilities it is about, by exact name
      }),
    )
    .max(3),
});
export type CoherenceOutput = z.infer<typeof coherenceOutput>;

const SYSTEM = `You check how a company's capabilities in Bike fit together, from each capability's text: its sheets, steps, rules and who can see and do what. List up to 3 real problems across them, the most important first:
- rules that disagree (two approval limits for the same kind of spending, two people who decide the same thing differently);
- a step nobody can move a row out of, or a decision that waits on no one;
- a hand-off that goes nowhere: a rule or connection that names something the other capability doesn't have.
Each item is one or two plain sentences that say what disagrees or is missing and why it matters, naming the capabilities, people and amounts as the texts give them. Only what the texts show; never invent a rule, amount or person. No items when nothing is wrong; don't list matters of taste or missing data.
${PLAIN_WORDS}

Answer with the JSON object only.`;

export const coherenceCheck: Prompt<CoherenceInput, CoherenceOutput> = {
  name: "coherence-check",
  version: 1,
  model: "large",
  effort: "medium",
  maxTokens: 4000,
  structured: true,
  system: SYSTEM,
  schema: coherenceOutput,
  render(i) {
    // With company rules (0.2): they count as rules too, and a capability a company rule's policy fits but doesn't
    // apply to is worth naming (a rule doesn't reach a capability created after it on its own).
    const message = i.companyRules?.length
      ? `Check how these capabilities fit together, with these company rules, which apply across the capabilities named:\n${JSON.stringify(i.companyRules)}\nName a capability a company rule's policy fits but doesn't apply to.`
      : "Check how these capabilities fit together.";
    return { context: JSON.stringify(i.capabilities), message };
  },
};
