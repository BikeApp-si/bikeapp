import { z } from "zod";
import { customizeChange, fillChange } from "@/server/kernel/customize/draft";
import type { Prompt } from "../prompt";
import { BUILDING_BLOCKS, EXPRESSIONS, PLAIN_WORDS } from "./shared";

// Version 10 (G1): a new link column can be a pick from a list, kept when that row goes.
// Version 9 (M32): says "app" for what it called a capability, in its own words and in every word it writes for people.
// Prompt 3, the Customize change planner (developer notes §8). Version 8 (M30): a new sheet can be kept by date. Version 7 (M29): a new sheet can be a ledger; set_formula. Version 6 (M28): a new sheet can be a tree. Version 4 (C1): who sees a sheet is a change; each
// role's access per sheet is in the context; a question's choices carry their changes, so the kernel checks each one
// before it's offered; a refusal said once is never said again the same way. A message in a capability's Customize chat →
// the changes to its file, by name. The kernel compiles and checks them, works out what they do to today's
// rows and shows the text as it will read; nothing is live until the admin clicks Apply. Rules come back as
// sentences for the logic writer (prompt 4). Context is one capability and the names of those it connects to.

export type CustomizeInput = {
  user: { name: string; email: string };
  company: { name: string; currency: string; timeZone: string }; // no date: recorded answers replay on any day
  capability: Record<string, unknown>; // this capability by name, with its roles, views and labels (customize/context.ts)
  text: string; // the Customize text as the admin sees it now
  connected: Record<string, unknown>[]; // capabilities it connects to, by name (structure.ts)
  // M27: every other capability's sheets and what names their rows, for link_column's target; sorted by name.
  others?: { name: string; sheets: { name: string; named_by: string }[] }[];
  people: { name: string; email: string; title: string | null }[];
  conversation: { from: "person" | "bike"; text: string }[]; // this capability's chat so far
  request: string;
  // Bike already gave this refusal in the chat; this time the answer is a question whose choices apply.
  refused?: string;
};

export const customizeOutput = z.object({
  // change: a plan of changes. clarify: one question with choices; nothing changes. data_task: the message is
  // about rows (who owns one, a value), which is done in the Data tab, not here. refuse: Bike can't do it
  // (it would move data in a way link_column doesn't), with the reason.
  type: z.enum(["change", "clarify", "data_task", "refuse"]),
  // The reply's first line. change: "Here's what changes. The text on the right shows how it will read.
  // Nothing is live until you apply." or what changes in a few words ("One step changes: Candidates end at
  // **Offer accepted or Rejected**."). A single new rule: "Here's how I read it:". Otherwise the whole reply.
  reply: z.string().min(1),
  // change: what changes, in a few words, to name the chat once it is applied ("Legal review step",
  // "Interviews sheet"). Otherwise null.
  title: z.string().min(1).max(40).nullable(),
  changes: z.array(customizeChange),
  // clarify: each choice with the changes it would make, so the kernel can check it; only its label is shown, and
  // a choice the admin picks comes back as their next message.
  clarify: z
    .object({
      question: z.string().min(1),
      options: z.array(z.object({ label: z.string().min(1).max(120), changes: z.array(customizeChange).min(1) })).min(2).max(4),
      hint: z.string().nullable(),
    })
    .nullable(),
});
export type CustomizeOutput = z.infer<typeof customizeOutput>;

// What a change can be, and what Bike does around it: shared with the guide (prompt 10), which writes the changes
// behind its suggestions in the same shape.
export const CHANGES_TEXT = `What a change can be, in this version (nothing else):
- add_sheet (new_sheet; a tree too, with kind "tree" and its tree_parent, for things that sit under each other: "add cost centres that sit under each other"; a ledger too, with kind "ledger", ledger_account, ledger_amount and ledger_min, for a balance kept as entries that are only added: "keep leave in a ledger"; a rule that adds an entry gives its amount signed, below 0 to take from the balance; a sheet kept by date too, with kind "dated", dated_key (the column saying what each value is for: a category, a product, a person; null for one series) and dated_from (the date it starts), for values that change from a date and stay as they were for the past: "keep spending limits for each category, each with the date it starts"; its key copies the choices of the question it matches (Category: the same options as the expenses' Category); a check or a computed question elsewhere reads the value in force on its row's date with inForce), add_column (sheet, column; a link to something picked from a list, such as a cost centre, a category or a customer, has link.pick true, so deleting that row empties the link and keeps this row; a link to the row this one belongs to has pick false and goes with it), add_step (sheet, step, after: the step it comes after; only_when for "only for contracts over $50,000").
- rename: the app itself (what "capability"), a sheet, a column or a step. Rows keep their place: a renamed step keeps its rows.
- set_step_movers: who may move a row out of and into a step (anyone, submitter, not_submitter).
- add_person_to_role: a person (by work email, only someone in People) into a role that lists people.
- set_sheet_access (role, sheet, access): how a role's people see a sheet's rows: all of them (sees "all"), only the rows a person column on the sheet names them in (sees "by_column", column), only the rows whose linked row names them (sees "through_link", via: a link column on the sheet, column: the person column on the row it points to), or none (sees "none"). Each role in the app lists how it sees each sheet now (sees).
- rule: a new rule, or one that replaces an existing rule (replaces: its sentence as it reads now), as one plain sentence; the logic writer turns it into the rule. A date rule can count from the day a row was added ("14 days after it was added") with no column for it: never add a date column for that. Changing when a reminder comes ("90 days instead of 60") replaces that rule.
- set_role_view: what a role's people see in place of the table (a line under the header, the columns, the form's fields).
- set_labels: what a row is called (row_one, row_many), the add action's name, a step's button.
- set_hint_column, set_default_sort, add_sheet_check.
- set_form (sheet, form): the sheet's form as a whole, as people fill it in: its tabs ("Basics", "Dates", "Documents"), each with one or more sections (a name, or null for none) listing its questions by name, in order; and quick, the questions asked when a row is added on top of the ones Bike always asks (the title, required questions, and what its checks and its rules for new rows read): null keeps them as they are, an empty list asks only the ones Bike always asks ("only ask for the customer and the value"). Write every tab the form should have, starting from the form as it is; a question left out of every tab goes in the last one. At most 5 tabs.
- link_column (sheet, link): a typed text column (link.column) becomes a link to rows of another sheet (link.to_sheet, in link.to_capability, or null for this one) — "pick the customer from Customers instead of typing it". The link takes the column's name; the typed values are kept beside it as "<name>, as typed", read only. Bike matches each typed value to a row by its name and shows every row it links, and every one it can't, before Apply; if any can't be linked, nothing moves. Only a text column, and only to a sheet whose rows are named by text.
- set_show_when (sheet, show_when): a question asked and shown only when a condition on the same row holds ("ask for a receipt only when the amount is over $75"), written as an expression with names; condition null shows it always again. A question that isn't shown is never required. Never on the title.
- set_formula (sheet, formula): a computed question worked out another way (formula.column, formula.formula as an expression with names), such as Left counting a ledger's entries for its Who. Only a computed question; its values are worked out again on Apply.
When a question becomes shown only sometimes and a rule for new rows waits for it to be filled in (an expense moves on "once its receipt is attached"), add a rule change in the same reply that also says what happens when it isn't asked ("An expense added with its receipt, or under $75, is Submitted").
A sheet that exists can't become a tree, a ledger or kept by date in this version, and a tree, a ledger or a sheet kept by date stays one. A computed question can be worked out another way with set_formula (formula: the column and its new formula; "Left counts the leave entries too": Days a year less Used, plus the ledger's balance for its Who), which moves no data; when a ledger takes over a balance kept by hand, keep the hand-kept column (Used) and add the ledger's balance to it, so today's numbers stay the same. In the same change set, give set_formula to every question that reads that balance less a row's own amount (a request's Balance after: Left less its Days), so a row the ledger has already counted isn't counted twice: once it is at the step whose rule adds its entry, or a later one (Approved or Taken), it reads the balance as it is. A request finds its person's Left with a lookup, a column of the row in another sheet of this app whose column matches one of this row's, as it already does: {"op":"if","args":[{"op":"in","args":[{"col":"Status"},"Approved","Taken"]},{"lookup":{"sheet":"Balances","where":"Who","is":"Who","value":"Left"}},{"op":"sub","args":[{"lookup":{"sheet":"Balances","where":"Who","is":"Who","value":"Left"}},{"col":"Days"}]}]}. Nothing else may move data: no removing a sheet, column, step, role or rule, no changing a column's type other than link_column. When the admin asks to remove a step that holds rows and says what should take its place ("Remove Hired. Offers should end at Offer accepted."), rename the step to it (rename, instead_of_removal true). When it can't be done without moving data, answer type "refuse" and say why in plain words.

A sheet you add is seen by every role that sees every row. A role that sees only its own rows sees the new sheet's rows by its person column (one called Owner, else the one filled with whoever adds the row, else the only one), or one link away through a link to a sheet it already decides by a person column; with neither, it doesn't see the new sheet until a set_sheet_access change says how. So for "add a companies sheet" under such a role: give the sheet an Owner column filled with whoever adds the row, or add a set_sheet_access change when the admin says who should see it ("only sales managers": sees "none" for the other roles).`;

const SYSTEM = `You change one app in Bike, an ERP small companies run their work in, from what its admin says in the app's Customize chat. You write the changes; the kernel checks them, shows the admin the app's text as it will read and what the change does to today's rows, and nothing is live until the admin clicks Apply. You never write data, never move a row and never do a person's task.

${BUILDING_BLOCKS}

${EXPRESSIONS}

${CHANGES_TEXT}

How you decide:
1. Only this app changes. The admin's latest message wins over earlier ones in the chat.
1a. When the admin changes something a rule already does (when a reminder comes, who is told, which step it moves to), that rule changes: a rule change that replaces it (replaces: its sentence as it reads now), never a second rule beside it. "Remind owners 90 days before the notice date" with a 60-day reminder in place moves that reminder to 90 days.
2. When you add a step that someone must approve or review ("a legal review by Lena"), also add a rule change: a sentence that has that person approve or decline rows at the step, so the rows wait on them. Put the person in a role that can move rows at that step when they aren't in one.
3. A message about rows, not about how the app works (who owns one contract, a value on a row, adding or approving a row), is type "data_task": say in one or two sentences that it is done in the Data tab, and how. Roles that follow a column (contract owners) need no change for a new person.
4. A message you can't map to these changes with confidence ("make sure big contracts are handled properly") is type "clarify": one question, 2–4 choices, each a short label with the changes it would make, and a hint line ("Or reply in your own words, with the amount and who decides."). Change nothing. Bike checks every choice; offer only choices that work in this version.
4a. When Bike says your changes can't be made, fix them with what it says; when no change can do what was asked, answer type "clarify" with the nearest choices that work, rather than "refuse". Answer "refuse" only when it would move data.
5. title: what this change set does, in two to four words, naming the thing it adds or changes ("Legal review step", "Interviews sheet", "Earlier renewal reminders"); null unless type is "change". explain: what each change does, for the admin, in one line. part: a short label for it while it is applied ("Steps: Legal review between Signed and Active", "Lena Ortiz can see and move every contract", "Reminder at 90 days before the notice date").
6. Use only names that exist in the app, the connected apps and People; a link_column may also link to a sheet of other_capabilities.

${PLAIN_WORDS}

Answer with the JSON object only.`;

export const customizePlanner: Prompt<CustomizeInput, CustomizeOutput> = {
  name: "customize-planner",
  version: 10,
  model: "large",
  effort: "high",
  maxTokens: 32000,
  structured: false,
  // An answer that leaves clarify out means none: a long change set dropped it while recording M29.
  // A change's unused fields left out are null too.
  fill: (json) => {
    if (!json || typeof json !== "object") return json;
    const j = json as { changes?: unknown; clarify?: unknown };
    return { ...j, clarify: "clarify" in j ? j.clarify : null, ...(Array.isArray(j.changes) ? { changes: j.changes.map(fillChange) } : {}) };
  },
  system: SYSTEM,
  schema: customizeOutput,
  render(i) {
    const context = JSON.stringify({ company: i.company, user: i.user, capability: i.capability, connected_capabilities: i.connected, other_capabilities: i.others ?? [], people: i.people }, null, 1);
    const message = [
      `How it reads now:\n${i.text}`,
      i.conversation.length ? `This chat so far:\n${i.conversation.map((m) => `${m.from === "person" ? i.user.name : "Bike"}: ${m.text}`).join("\n")}` : "",
      `Latest message from ${i.user.name}:\n${i.request}`,
      i.refused ? `Bike has already answered this with: "${i.refused}"\nDon't say that again. Answer type "clarify": one question with choices that each work in this version.` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return { context, message };
  },
};
