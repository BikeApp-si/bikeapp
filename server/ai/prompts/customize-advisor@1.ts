import { z } from "zod";
import { BIKE_GUIDE } from "@/server/ai/guide/bike-guide";
import { customizeChange } from "@/server/kernel/customize/draft";
import type { SheetProfile } from "@/server/kernel/profile";
import type { Prompt } from "../prompt";
import { CHANGES_TEXT } from "./customize-planner@8";
import { BUILDING_BLOCKS, EXPRESSIONS, PLAIN_WORDS } from "./shared";

// Prompt 11, the Customize advisor (C3, large model). "What else should I add?", "how can this be better?": advice an
// expert would give for this company and this capability, grouped (start with these, add as you grow, views and
// reports), each with its fields and why. Only admins ask, so it recommends freely and may use what it knows about how
// such a business works; but every item is placed where Bike can build it, and an item changed here carries its
// changes so the kernel checks it before it's a button. It changes nothing. It reads counts about the data, never rows.

export const PLACES = ["here", "capability", "view", "report", "not_yet"] as const;

export type AdvisorInput = {
  text: string; // the capability as the Customize text reads
  capability: Record<string, unknown>; // by name, with each role's access per sheet (customize/context.ts)
  counts: SheetProfile[]; // rows, empty questions, choices used (server/kernel/profile.ts)
  others: string[]; // the company's other capabilities, by name
  room: number; // sheets this capability can still add
  conversation: { from: "person" | "bike"; text: string }[];
  message: string;
};

export const advisorOutput = z.object({
  intro: z.string().min(1).max(500),
  groups: z
    .array(
      z.object({
        title: z.string().min(1).max(40), // "Start with these", "Add as you grow", "Views and reports"
        items: z
          .array(
            z.object({
              title: z.string().min(1).max(60), // "Categories"
              why: z.string().min(1).max(400), // what it gives them, in this company's terms
              fields: z.array(z.string().min(1).max(80)).max(10), // "Monthly budget (money)"
              // here: in this capability (changes required); capability: its own, connected (request for Home); view: a
              // saved view or grouping (said in words); report: asked in Home's chat (request); not_yet: Bike can't yet
              // (why says the nearest).
              place: z.enum(PLACES),
              request: z.string().min(1).max(100).nullable(), // in the admin's words, short, for here, capability and report
              changes: z.array(customizeChange), // here only; empty otherwise
            }),
          )
          .min(1)
          .max(6),
      }),
    )
    .min(1)
    .max(3),
  start: z.string().min(1).max(400), // where to begin, and why
});
export type AdvisorOutput = z.infer<typeof advisorOutput>;

const SYSTEM = `You advise the admin of one capability in Bike on what would make it better: what to add first, what later, and what to look at on top. Write what an experienced operator in this kind of business would recommend for this company, using what you know about how such work is done. You change nothing: Bike shows your advice, and each item the admin can apply becomes a button that sends its request to the change planner.

${BIKE_GUIDE}

How you advise:
1. Give three groups: "Start with these" (two to four that fix data quality or give answers right away), "Add as you grow" (two to four that come next as the company grows; often their own capabilities, connected to this one, since this capability has room for only a few more sheets), and "Views and reports" (two to four things to look at on top).
2. Each item: a short title, why it helps in this company's terms (what it lets them see or stop doing wrong), and its fields as "Name (type)", with links written as "Contact (link to Contacts)" and totals as "Spent this month (total of linked entries)".
3. Place each item where Bike can build it, and say so with place:
   - here: in this capability. Give its changes in the shape below, and request: what the admin would type, short, like a button ("Add a Contacts sheet"). At most "room" new sheets across all here items; a link column or a computed total that a here sheet needs goes in the same item's changes.
   - capability: a different job, better as its own capability connected to this one (Invoices beside Income and expenses). request is what to tell Bike to build it, naming the link back.
   - view: a saved view, grouping or board, said in why ("Group entries by month, with totals"). request null.
   - report: asked in Home's chat; request is the question to ask.
   - not_yet: Bike can't do it in this version; why says so and gives the nearest it can do. request null.
4. Use the counts: they are about the company's own rows (how many, how many have each question empty, which choices are used). Point out what they show ("4 entries have no category") where it supports an item. Never ask for or mention row values.
5. Use only the capability's own names for what exists; new things get plain names. Never offer what the capability already has.
6. intro: one or two sentences on what would help most. start: where to begin, and why, in one or two sentences.

The changes for a "here" item, by name (as the change planner writes them):
${BUILDING_BLOCKS}

${EXPRESSIONS}

${CHANGES_TEXT}

${PLAIN_WORDS}

Answer with the JSON object only.`;

export const customizeAdvisor: Prompt<AdvisorInput, AdvisorOutput> = {
  name: "customize-advisor",
  version: 1,
  model: "large",
  effort: "medium",
  maxTokens: 8000,
  structured: false,
  system: SYSTEM,
  schema: advisorOutput,
  render(i) {
    const context = JSON.stringify({ capability: i.capability, other_capabilities: i.others, room_for_sheets: i.room, counts: i.counts }, null, 1);
    const turns = i.conversation.map((m) => `${m.from === "person" ? "Admin" : "Bike"}: ${m.text}`).join("\n");
    const message = [`How it reads now:\n${i.text}`, turns ? `The chat so far:\n${turns}` : "", `Latest message:\n${i.message}`].filter(Boolean).join("\n\n");
    return { context, message };
  },
};
