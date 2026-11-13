import { z } from "zod";
import type { Prompt } from "../prompt";
import { PLAIN_WORDS } from "./shared";

// Version 2 (M32): says "app" for what it called a capability, in its own words and in every word it writes for people.
// Three short suggestions under "What should change in {capability}?" (6b, 6g), written once per saved version
// by the small model. Only changes this version can apply (adding or renaming); the kernel checks every name
// each one uses before it is stored. If this call fails, there are no chips: a save is never held up by it.

export type SuggestionsInput = {
  capability: Record<string, unknown>; // by name, with its roles (customize/context.ts)
  text: string; // how it works now, as the Customize text reads
  people: { name: string; email: string }[];
};

export const SUGGESTION_KINDS = ["add_step", "add_column", "rename", "add_person_to_role", "rule", "set_role_view", "set_labels"] as const;

export const suggestionsOutput = z.object({
  suggestions: z.array(
    z.object({
      text: z.string().min(1).max(40), // "Add a legal review for big contracts"
      kind: z.enum(SUGGESTION_KINDS),
      // Every sheet, column, step, role and person name the suggestion relies on, exactly as given.
      names: z.array(z.string()),
    }),
  ),
});
export type SuggestionsOutput = z.infer<typeof suggestionsOutput>;

const SYSTEM = `You suggest three short changes an admin might want in one app of Bike, an ERP for small companies. Each is a chip the admin clicks to send as their message, so write it as they would say it: under 40 characters, starting with a verb or "Let …" (for an orders capability: "Add an approval for large orders", "Remind managers a day sooner", "Let Dana see every order").

Only suggest what this version can apply: adding a step, a column or a rule, changing when a reminder comes, renaming something, adding a person to a role, or changing what a role sees. Never removing anything, never changing a column's type, never moving data. Never suggest what the app already does: read how it works now first. Use only names that exist in the app and People, and list them in names.

${PLAIN_WORDS}`;

export const customizeSuggestions: Prompt<SuggestionsInput, SuggestionsOutput> = {
  name: "customize-suggestions",
  version: 2,
  model: "small",
  effort: "low",
  maxTokens: 1000,
  structured: true,
  system: SYSTEM,
  schema: suggestionsOutput,
  render(i) {
    return { context: JSON.stringify({ people: i.people }, null, 1), message: `The capability:\n${JSON.stringify(i.capability, null, 1)}\n\nHow it works now:\n${i.text}` };
  },
};
