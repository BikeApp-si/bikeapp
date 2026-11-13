import type { CHANGE_KINDS } from "@/server/kernel/customize/draft";
import { LIMITS } from "@/server/kernel/schema/validate";

// The Bike guide (C2): what Bike can do today, written by us and checked like code (bike-guide.test.ts). The guide
// prompt answers only from it and the capability's own text, so it never invents a feature. Update it whenever a
// milestone changes what Bike can do (/wrap-up), and bump GUIDE_VERSION: recorded answers are keyed by it.

export const GUIDE_VERSION = 13;

// What each Customize change does, in an admin's words. Typed by the change kinds, so a new kind can't be added
// without saying what it is here.
export const CHANGES: Record<(typeof CHANGE_KINDS)[number], string> = {
  add_sheet: "Add a sheet (a new list in the app, with its own questions and steps), or a sheet whose rows sit under each other (cost centres, categories), with totals that include the rows under each one, or a ledger, whose entries are only added (leave taken and given, stock moves in and out), with a balance Bike works out, or a sheet kept by date (a price list, salaries, spending limits), whose values each start on a date.",
  add_column: "Add a question (a column) to a sheet: text, long text, number, money, a money range, percent, date, date and time, days, a person, email, phone, link to a web page, a file, a choice from a list, a link to a row in another sheet, or a computed value.",
  add_step: "Add a step to a sheet's flow, after a step that's already there; a step can apply only to some rows (\"only for contracts over $50,000\").",
  rename: "Rename the app, a sheet, a question or a step. Rows keep their place: a renamed step keeps its rows. Asking to remove a step that holds rows can become renaming it to what should replace it.",
  set_step_movers: "Say who may move a row out of or into a step: anyone, only the person who asked, or anyone but the person who asked.",
  add_person_to_role: "Add someone from People to a role that lists people by name.",
  rule: "Add a rule in one sentence, or change one that's there (\"remind the owner 90 days before the notice date instead of 60\"). Rules start when a row is added, reaches a step, has a value changed, or a date comes, or repeat on a schedule to add rows by themselves (\"every month on the 1st, add the office rent\": every week on a weekday, every month on a day, or every year on a date, from a start date until an end date if you like; each row they add is filled in by the rule, for the person it names); they add or update a row (here or in another app), move a row to a step, email people, make a row wait on one person to approve or decide, or have an AI suggest a value that a person confirms.",
  set_role_view: "Give a role its own simple view in place of the table: a line under the header, the columns they see and the questions they fill in.",
  set_labels: "Change what a row is called (\"a lead\", \"leads\"), the name of the add button (\"New lead\"), or what a step's button says (\"Mark won\").",
  set_hint_column: "Show one question as a small hint beside another in the table.",
  set_default_sort: "Choose how a sheet is sorted when it opens.",
  add_sheet_check: "Add a check a row must pass before it's saved (\"the end date is after the start date\").",
  set_form: "Lay out a sheet's form: its tabs (at most 5), sections and the order of questions, and which questions are asked when a row is first added.",
  set_show_when: "Ask a question only when something else on the row holds (\"ask for a receipt only when the amount is over $75\").",
  set_sheet_access: "Say how a role sees a sheet's rows: all of them, only the rows a person question names them in (such as Owner), only rows whose linked row names them, or none.",
  set_formula: "Change how a computed question is worked out (\"Left counts the leave entries too\"). Bike works it out again for every row when you apply it.",
  link_column: "Turn a typed question into a link to rows of another sheet (the customer typed on each contract becomes a link to its row in Customers). Bike matches each typed value to a row by its name and shows every row it links, and every row it can't, before Apply; if any can't be linked, nothing moves. The typed values are kept, read only, beside the link.",
};

export const BIKE_GUIDE = `# The Bike guide (version ${GUIDE_VERSION})

Bike is an ERP for companies of 10 to 50 people. Each part of the work is an app (Customer contracts, Hiring, Spend). Admins build apps from plain words or documents and change them in Customize; everyone works in them by point and click.

## An app
- Sheets: lists of rows, each with its questions (columns). A sheet can be a plain list, a document with lines (a bill and its items), an allocation (payments split across bills), a tree, whose rows sit under each other (cost centres, categories, classes and their sections), at most ${LIMITS.treeDepth} levels deep, a ledger, whose entries are only added and add up to a balance (leave, stock moves, fee dues), or kept by date, whose values each start on a date and last until the next (price lists, salaries, spending limits, fee structures by year). An app has at most ${LIMITS.sheets} sheets.
- Questions: at most ${LIMITS.columns} on a sheet. A question can be required, have a default ("whoever adds it", today, a fixed value, a formula, or a value from the row it links to: a candidate's hiring manager from its opening, filled when the row is added), or be computed from others.
- Steps: a row moves through a sheet's steps (Draft → Signed → Active → Renewed or Ended). At most ${LIMITS.steps} steps before the end steps.
- Rules: what happens by itself, at most ${LIMITS.rules} in an app. A rule never runs another rule more than 3 deep, and a rule that would set off itself is refused.
- Roles: who can see and do what. A role is people named one by one, everyone a person question names (say, every contract's Owner), or everyone. It can see, add, edit, delete, move rows through steps and change how the app works, on every row, only their own rows, or their team's.
- Connections: a rule can start or update a row in another app (a hired candidate starts an onboarding plan).

## Who sees a new sheet
A role that sees every row sees a new sheet too. A role that sees only its own rows sees a new sheet's rows by its Owner question, or the person question filled with whoever adds the row; or one link away, when the new sheet links to a row the role already sees by a person. With none of these, the role doesn't see the new sheet until an admin says how, so admins see it first. A new ledger kept per person (leave entries) is different: a role that sees its own rows only sees the entries that name them, and never adds or reverses one, so nobody gives themselves days; a role that sees its team's rows doesn't see it until an admin says so. Customize can then say how a role sees any sheet: all rows, by a person question, through a link, or none.

## Building an app well
- A list in place of typed text: a choice question, or a sheet of its own (Categories, Contacts) that rows link to, so names are spelled one way and each one can show what's linked to it.
- Totals: a computed question can add up the rows that link to a row ("Spent this month" on a budget adds up the entries that point at it; "Lifetime revenue" on a contact), here or in another app, counting only rows at some steps if wanted.
- Two apps work together through a link (an entry picks its invoice in Invoices) or a rule (a hired candidate starts an onboarding plan). An app that does a different job is better as its own, connected, than as a fourth sheet.
- Things that sit under each other (cost centres, categories) as a tree: each row names the one it sits under, a total can include every row under it, and Bike refuses a row under itself or under a row below it, and deleting a row that has rows under it.
- Balances as a ledger (leave days, stock, fees due): each entry adds or takes an amount for a person or a row (an item), and Bike keeps the balance after each entry and on the row it counts toward. An entry is never changed or deleted: a wrong one is reversed, once, with Reverse, which adds the opposite entry. A ledger can say its balance never goes below a number (stock never below 0), and Bike refuses any entry, from a person, a rule or an import, that would take it lower. A rule can add an entry (an approved request takes its days off).
- Values by date (a price list, salaries, spending limits by category): each row says what it's for (a product, a person, a category) and the date it starts; Bike keeps Until, the day before the next one starts, and allows one row for the same thing on the same day. A row already in force can't be changed or deleted, so what applied on a past day stays: a change is a new row from the date it changes. A row still to come can be changed or deleted. A check or a computed question elsewhere reads the value in force on its own date (an expense within its category's limit on the expense's date; a quote's price on its date).
- Steps for anything that moves through stages (Draft → Sent → Paid), with who may move it and who it waits on; a check that a row must pass before it's saved.

## What Customize can change
${Object.values(CHANGES).map((c) => `- ${c}`).join("\n")}

Nothing is live until the admin clicks Apply. Before that, the text on the right shows how the app will read and the chat says what changes for today's rows.

Customize also answers questions ("how do I…", "why can't…") and gives advice ("what else should I add?"): what to add first and later, each with its fields, why it helps and where it would live, a button for each change it can make here, and a link to Home for what is its own app or a report. Advice and answers change nothing.

## What Customize can't change in this version, and the nearest
- Remove a sheet, question, step, role or rule, or change a question's type (other than turning typed text into a link, above): these would move data. The nearest: rename it, or stop using it; a step that holds rows can be renamed to what should replace it.
- Go past the limits above (${LIMITS.sheets} sheets, ${LIMITS.columns} questions a sheet, ${LIMITS.steps} steps, ${LIMITS.rules} rules). The nearest: add the questions to a sheet that's there (offer details on Candidates rather than an Offers sheet), or make a second app and connect them with a rule.
- A role that sees rows two links away. The nearest: a person question on the sheet itself (an Owner), or one link to a row the role already sees.
- Turn a sheet that's there into a tree, or a tree back into a list. The nearest: add a new sheet as a tree and link the rows to it.
- Turn a sheet that's there into one kept by date, or change what it's kept by or the date it starts on. The nearest: add a new sheet kept by date.
- Turn a sheet that's there into a ledger, or change a ledger's account, amount or lowest balance. The nearest: add a new ledger sheet; a balance kept by hand (Used) can stay as it is, with the ledger's entries added to it.
- Change a company rule: those are in the Ontology's Company rules tab, and an app's text shows the ones that apply to it.

## Elsewhere in Bike
- The Data tab: the table, each row's record with its tabs, related rows, notes and history; saved views (personal or shared), columns, search (/), filters, sort, a board by step and grouping with subtotals; Download CSV. A tree shows each row under the one it sits under, with a fold for each branch. A ledger's entries can't be changed or deleted there; each has Reverse. A sheet kept by date marks the row in force and the ones still to come; one in force has no Edit or Delete. Deleting a row that other rows picked from a list (a cost centre their expenses picked) keeps those rows, with that question left empty. Changing a value, an owner or a row's step is done here, not in Customize.
- Views: each person can save views of a sheet (filters, sort, columns), keep them to themselves or share them; group a sheet by a question with subtotals; see rows as a board by step. "Entries without a category" or "This month by category" is a view, not a change to the app.
- Reports (admins): asked in words in Home's chat ("income against expenses by month this year"), answered with a table, a bar or line chart, CSV and PDF, and Run again. Burn and runway, or a monthly summary, is a report. Save keeps a report on the Reports page; Email it to me sends it as a PDF every day, every week on a weekday or every month on a day, at 07:00 in the company's time zone, to the admin who saved it, run with their access.
- Waiting on me: the rows waiting on a person, with a count in the sidebar and a morning email.
- Inbox, for everyone: To do (everything waiting on them, across apps), Waiting on others (rows they sent that wait on someone else, and on whom) and Updates (what others did to the rows they sent, are named in or were asked about, newest first, new ones marked). Each opens its row.
- Help: each app's own how-to, written for each person's access. Docs, at bikeapp.si/docs: how all of Bike works, page by page, for admins and everyone.
- ⌘K: jump to any row, app or action the person may see.
- Chats (admins): build an app from words or documents, import a spreadsheet, ask for a report with a chart, CSV and PDF, and run it again; search your chats by their words.
- Ontology (admins): how the company runs in plain words, every connection, and the Company rules tab for rules across apps; its past versions with their dates, to read or download.
- Audit log (admins): every change, who made it and where it came from. Every Monday at 07:00 each admin gets an email of what changed last week in the apps they can see: rows added and moved, rules run, what stopped, and the rows waiting longest.
- App sets (admins): from Home, "Or start from an app set" adds a ready set of apps in three steps: pick the apps, say who fills each role, then check the plan and click Add these apps. It uses no AI. Listed now, both in beta: a K-12 school (CBSE) and a professional services firm. A set's apps are then changed in Customize like any other.
- People: the team, their titles and managers. Settings (admins): the company's logo, name, website and address; its currency, how numbers and dates are written (12,34,567 and 14 Nov 2026 for a company in India) and the month its financial year starts, which reports and filters use for "this year"; and its admins. Changing the currency doesn't convert amounts.
- A company's own Bike (run on its own server from the open-source code, for one company at one address) has two more Settings tabs for admins. AI: the company's Anthropic key (Replace, Remove), a monthly cap in dollars (when this month's use reaches it, building and changing apps waits until the 1st; everyday work never stops) and this month's AI use. With no key, everything works except building and changing apps from words or documents, reports from questions, filters in plain words, reading a dropped document into a form and each app's How to use; apps then come from an app set. Instance: the version, and when a newer one is out, the command that updates it on the server; the address; and a health check of the database, file storage, virus scanner, email, clock, AI and backups, each with how to fix it. Updating Bike and its nightly backups are done on the server, not in Bike.

## Not in Bike yet
Connections to other software (Slack, QuickBooks, Xero, banks, email inboxes), an Automations page, dashboards, forms for people outside the company, mobile apps, more than one company in a workspace, custom domains, and an AI that does a person's task on its own. A rule can email people in the company; that is the nearest to a message in another app.`;
