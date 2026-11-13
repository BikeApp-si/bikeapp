import { z } from "zod";
import { type Prompt } from "../prompt";
import { PLAIN_WORDS } from "./shared";
import type { AccessSummary } from "@/server/kernel/access-summary";

// Version 3 (S1): an admin's cannot names only what nobody can do here, from access, where it said empty for an admin.
// Version 2 (M32): says "app" for what it called a capability, in its own words and in every word it writes for people.
// A capability's tutorial (0.4, M24, small model), written for one kind of access from the access summary alone: what
// it's for, the reader's everyday jobs as numbered steps, what waits on whom, and what they can't do. The kernel checks
// every step against the summary (server/kernel/tutorial.ts) before it's kept.

export type TutorialInput = { company: string; access: AccessSummary };

export const tutorialOutput = z.object({
  purpose: z.string().min(1).max(240),
  steps: z
    .array(
      z.object({
        title: z.string().min(1).max(60),
        text: z.string().min(1).max(320),
        does: z.object({ kind: z.enum(["add", "edit", "move", "read", "wait"]), sheet: z.string(), step: z.string().nullable() }),
      }),
    )
    .min(1)
    .max(6),
  waits: z.array(z.string().min(1).max(200)).max(4),
  cannot: z.array(z.string().min(1).max(200)).max(3),
});
export type TutorialOutput = z.infer<typeof tutorialOutput>;

const SYSTEM = `You write a short tutorial for one app in Bike, for one person, from what their access lets them do (access). It shows them how to do their everyday work there.

- purpose: one or two sentences on what the app is for, from their side ("Where you claim back what you paid for work.").
- steps: 1 to 6 numbered steps for the jobs they will do most, in the order they happen. Each has a short title ("Add an expense"), one to three sentences of text in the second person, and does: what it asks of them.
  - does.kind "add" only when access gives the sheet an add action (use its words in the title); "edit" only when they may edit; "move" only into a step listed in that sheet's movesTo, naming it in does.step; "read" to look something up; "wait" for what happens next without them. does.sheet is the sheet's name exactly as given.
  - Never a step for something access doesn't give them. A step another person takes is not theirs: put it under waits.
  - When they may move other people's rows on (movesTo has a step such as an approval or payment, and they see more than their own), that is their work: give it a step ("Approve expenses that wait on you"), with its stepRules.
  - view, when given, is the one table they work from: start from it.
  - Say whose rows they see when it isn't all ("You see only your own expenses.").
- waits: up to 4 short lines on what waits on whom, from the sheets' steps, stepRules and rules ("Lena approves it; you can't approve your own.").
- cannot: up to 3 short lines on what they can't do here, when it matters (they can't add, can't move rows on, see only their own). For an admin, only what nobody can do here, from access: entries that are only added (reverse), rows in force on a dated sheet, a step the submitter can't take (say "your own"), a sheet nobody adds to or deletes from. Empty when there is none.
Use the app's own words for sheets, steps and columns, exactly as given. No ids, no field types, no mention of roles, access or Bike's settings.
${PLAIN_WORDS}

Answer with the JSON object only.`;

export const tutorialWriter: Prompt<TutorialInput, TutorialOutput> = {
  name: "tutorial-writer",
  version: 3,
  model: "small",
  effort: "low",
  maxTokens: 3000,
  structured: true,
  system: SYSTEM,
  schema: tutorialOutput,
  render(i) {
    return { context: JSON.stringify({ company: i.company }), message: JSON.stringify({ access: i.access }) };
  },
};
