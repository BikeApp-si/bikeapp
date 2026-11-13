import { z } from "zod";
import type { Prompt } from "../prompt";

// Prompt 9, the Customize router (C2, small model): a message typed in a capability's Customize chat goes to the
// change planner (prompt 3), the guide (prompt 10) or, from C3, the advisor (prompt 11). Messages sent from buttons never come here: they already say
// where they go. It only picks the way; it never answers.

export type RouterInput = {
  capability: string; // the capability's name
  conversation: { from: "person" | "bike"; text: string }[]; // the last few turns, oldest first
  refused: boolean; // Bike's last reply said it couldn't make a change
  message: string;
};

export const routerOutput = z.object({ way: z.enum(["change", "explain", "advise", "unsure"]) });
export type RouterOutput = z.infer<typeof routerOutput>;

const SYSTEM = `An admin is typing in the Customize chat of one capability in Bike, an ERP for small companies. Customize can change how the capability works (add a sheet, a question, a step or a rule, rename things, say who sees what), or explain how it works and what Bike can do. Pick the way for their latest message:
- "change": they ask for something to be different ("Add a Companies sheet", "Only sales managers should see them", "Remind owners 90 days before"), or say yes to a change Bike offered.
- "advise": they ask what would make the capability better or what to add, open-ended ("What other sheets can be added here to improve this?", "How can this be better?", "What am I missing?", "What do companies like ours track for hiring?").
- "explain": they ask how, why, what or whether ("How do I add a sheet?", "Why can't lead owners see companies?", "What does Owner mean?", "Can Bike send a Slack message?", "tell me the steps"), or push back on a refusal without asking for a new, specific change.
- "unsure": a word or two that could be either ("Companies?", "owners").
Answer with the JSON object only.`;

export const customizeRouter: Prompt<RouterInput, RouterOutput> = {
  name: "customize-router",
  version: 2,
  model: "small",
  effort: "low",
  maxTokens: 200,
  structured: true,
  system: SYSTEM,
  schema: routerOutput,
  render(i) {
    const turns = i.conversation.map((m) => `${m.from === "person" ? "Admin" : "Bike"}: ${m.text}`).join("\n");
    return {
      context: `Capability: ${i.capability}`,
      message: [turns ? `The chat so far:\n${turns}` : "", i.refused ? "Bike's last reply said it couldn't make a change." : "", `Latest message:\n${i.message}`].filter(Boolean).join("\n\n"),
    };
  },
};
