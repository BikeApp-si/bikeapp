import type { PlannerOutput } from "@/server/ai/prompts/workspace-planner@2";
// Plans as the AI writes them (by name), for kernel tests: 5c's Customer contracts and 5j's Supplier bills with
// its 3 Also changes. Test data only.
import type { DraftAlsoChange, DraftCapability, DraftColumn, DraftRule, DraftStep } from "./draft";

export const col = (name: string, type: DraftColumn["type"], more: Partial<DraftColumn> = {}): DraftColumn => ({
  name, type, required: false, default: null, options: [], link: null, formula: null, result: null, ...more,
});
export const stp = (name: string, more: Partial<DraftStep> = {}): DraftStep => ({ name, start: false, end: null, button: null, only_when: null, move_out: "anyone", move_in: "anyone", ...more });
const rule = (r: Omit<DraftRule, "condition"> & { condition?: string | null }): DraftRule => ({ condition: null, ...r });
const act = (a: Partial<DraftRule["actions"][number]> & { kind: DraftRule["actions"][number]["kind"] }): DraftRule["actions"][number] => ({
  step: null, target: null, via: null, map: [], people: [], columns: [], message: null, person: null, column: null, manager_of: null, until: null, label: null, decision: null, question: null, answer_column: null, ...a,
});
export const J = (e: unknown) => JSON.stringify(e);

export const contracts: DraftCapability = {
  name: "Customer contracts",
  icon: "file-pen-line",
  sheets: [
    {
      name: "Contracts", kind: "list", parent_sheet: null, title_column: "Customer", row_one: "contract", row_many: "contracts", add_action: "New contract",
      columns: [
        col("Customer", "text", { required: true }),
        col("Value a year", "money", { required: true }),
        col("Start", "date"),
        col("Renews on", "date", { default: { kind: "formula", value: J({ op: "date_add", args: [{ col: "Start" }, 1, "years"] }) } }),
        col("Notice", "days", { default: { kind: "value", value: "30" } }),
        col("Notice date", "computed", { result: "date", formula: J({ op: "date_add", args: [{ col: "Renews on" }, { op: "mul", args: [{ col: "Notice" }, -1] }, "days"] }) }),
        col("Owner", "person", { default: { kind: "creator", value: null } }),
        col("Signed contract", "file"),
        col("Status", "step"),
      ],
      steps: [stp("Draft", { start: true }), stp("Signed"), stp("Active"), stp("Renewal due"), stp("Renewed", { end: "final", button: "Mark renewed" }), stp("Ended", { end: "exit", button: "End contract" })],
    },
  ],
  roles: [
    { name: "Contract managers", people: ["wade@fernwood.dev", "krishna@fernwood.dev"], person_column: null, everyone: false, can: ["see", "add", "edit", "delete", "move_steps", "customize"], scope: "all", scope_columns: [], sheets: null },
    { name: "Contract owners", people: [], person_column: { sheet: "Contracts", column: "Owner" }, everyone: false, can: ["see", "edit", "move_steps"], scope: "own", scope_columns: [{ sheet: "Contracts", column: "Owner", via: null }], sheets: null },
  ],
  later: ["A Contacts sheet linked to each contract", "An AI step that reads signed PDFs into the row"],
};

export const contractRules: DraftRule[] = [
  rule({
    capability: "Customer contracts", sheet: "Contracts",
    text: "60 days before a contract’s notice date, move it to Renewal due and remind its owner.",
    when: "60 days before a contract’s notice date", then: "It moves to Renewal due and its owner is reminded",
    trigger: { kind: "date_reached", step: null, field: null, date: "Notice date", offset_days: -60 },
    actions: [act({ kind: "ask_person", column: "Owner", step: "Renewal due", label: "Decide on the renewal" }), act({ kind: "notify", columns: ["Owner"], message: "This contract is due for renewal." })],
  }),
  rule({
    capability: "Customer contracts", sheet: "Contracts",
    text: "30 days before the notice date, if it is still in Renewal due, tell Wade and the owner.",
    when: "30 days before the notice date, while it is in Renewal due", then: "Wade and the owner are told",
    trigger: { kind: "date_reached", step: null, field: null, date: "Notice date", offset_days: -30 },
    condition: J({ op: "eq", args: [{ col: "Status" }, "Renewal due"] }),
    actions: [act({ kind: "notify", people: ["wade@fernwood.dev"], columns: ["Owner"], message: "This contract is still waiting for a renewal decision." })],
  }),
];

// 5j: Supplier bills, with what it adds to Spend and Tools and budgets.
export const bills: DraftCapability = {
  name: "Supplier bills",
  icon: "receipt",
  sheets: [
    {
      name: "Bills", kind: "list", parent_sheet: null, title_column: "Supplier", row_one: "bill", row_many: "bills", add_action: "Add a bill",
      columns: [
        col("Supplier", "text", { required: true }),
        col("Bill number", "text", { required: true }),
        col("Amount", "money", { required: true }),
        col("Due date", "date"),
        col("Purchase", "link", { required: true, link: { capability: "Spend", sheet: "Purchases" } }),
        col("Budget", "link", { link: { capability: "Tools and budgets", sheet: "Budgets" } }),
        col("Bill", "file"),
        col("Status", "step"),
      ],
      steps: [stp("Received", { start: true }), stp("Matched"), stp("Approved"), stp("Paid", { end: "final" })],
    },
  ],
  roles: [
    { name: "Bill managers", people: ["wade@fernwood.dev", "lena@fernwood.dev", "krishna@fernwood.dev"], person_column: null, everyone: false, can: ["see", "add", "edit", "move_steps"], scope: "all", scope_columns: [], sheets: null },
    { name: "Purchase requesters", people: [], person_column: null, everyone: true, can: ["see"], scope: "own", scope_columns: [{ sheet: "Bills", column: "Requested by", via: "Purchase" }], sheets: null },
  ],
  later: [],
};

const within2 = { op: "between", args: [{ col: "Amount" }, { op: "mul", args: [{ col: "Total", via: "Purchase" }, 0.98] }, { op: "mul", args: [{ col: "Total", via: "Purchase" }, 1.02] }] };
const received = { op: "eq", args: [{ col: "Status", via: "Purchase" }, "Received"] };
export const billRules: DraftRule[] = [
  rule({
    capability: "Supplier bills", sheet: "Bills", text: "When a bill is added, match it to its purchase; if it agrees within 2%, move it to Matched.",
    when: "A bill is added", then: "It is matched to its purchase; within 2%, it moves to Matched",
    trigger: { kind: "row_created", step: null, field: null, date: null, offset_days: null },
    condition: J({ op: "and", args: [within2, received] }),
    actions: [act({ kind: "move_to_step", step: "Matched" })],
  }),
  rule({
    capability: "Supplier bills", sheet: "Bills", text: "When a bill doesn't match exactly, an AI step suggests the closest purchase line; Lena confirms.",
    when: "A line doesn't match exactly", then: "An AI step suggests the closest purchase line and says why; Lena confirms",
    trigger: { kind: "row_created", step: null, field: null, date: null, offset_days: null },
    condition: J({ op: "not", args: [{ op: "and", args: [within2, received] }] }),
    actions: [act({ kind: "ai_step", question: "Which purchase line is closest to this bill, and why?" })],
  }),
  rule({
    capability: "Supplier bills", sheet: "Bills", text: "Before a bill over $2,000 moves to Approved, ask Krishna to approve.",
    when: "A bill over $2,000 is Matched", then: "Krishna approves it before it can be paid",
    trigger: { kind: "enters_step", step: "Matched", field: null, date: null, offset_days: null },
    condition: J({ op: "gt", args: [{ col: "Amount" }, 2000] }),
    actions: [act({ kind: "ask_person", person: "krishna@fernwood.dev", step: "Matched", label: "Approve the bill" })],
  }),
  rule({
    capability: "Supplier bills", sheet: "Bills", text: "When a bill is Paid, move its purchase to Billed.",
    when: "A bill is Paid", then: "Its purchase moves to Billed",
    trigger: { kind: "enters_step", step: "Paid", field: null, date: null, offset_days: null },
    actions: [act({ kind: "update_row_in", target: { capability: "Spend", sheet: "Purchases" }, via: "Purchase", map: [{ column: "Status", value: J("Billed") }] })],
  }),
];

export const alsoChanges: DraftAlsoChange[] = [
  { capability: "Spend", sheet: "Purchase lines", change: "Add a Received quantity column", reason: "So each bill can be matched to what arrived", kind: "add", edits: [{ kind: "add_column", sheet: "Purchase lines", column: col("Received quantity", "number"), step: null, after: null, role: null, person: null, link: null }] },
  { capability: "Spend", sheet: "Purchases", change: "Add a Billed step after Received", reason: "So you can see which purchases are waiting for a bill", kind: "add", edits: [{ kind: "add_step", sheet: "Purchases", column: null, step: stp("Billed"), after: "Received", role: null, person: null, link: null }] },
  {
    capability: "Tools and budgets", sheet: "Budgets", change: "Add a Spent column next to each budget", reason: "So paid bills count against the owner’s budget", kind: "add",
    edits: [{ kind: "add_column", sheet: "Budgets", column: col("Spent", "computed", { result: "money", formula: J({ sumOf: { capability: "Supplier bills", sheet: "Bills", column: "Amount", by: "Budget", steps: ["Paid"] } }) }), step: null, after: null, role: null, person: null, link: null }],
  },
];

// A plan for the synthetic document pack (tests/files/pack), as prompt 1 might write it (4b).
export const PACK_PLAN: PlannerOutput = {
  lead: "I read your write-up, 38 pages of policy and 6 files from Zoho. I'll fill People first, then build **6 apps** in this order, so each one can use the ones before it.",
  people: { file: "employees.csv", what: "14 people, 5 teams, who reports to whom" },
  capabilities: [
    { name: "Hiring", icon: "briefcase-business", what_it_runs: "Openings, candidates and interviews", purpose: "A row is a candidate.", data: ["candidates.csv"], pages: [{ file: "Fernwood policies.pdf", pages: [2, 3] }], rules: ["When a candidate is hired, tell Wade."] },
    { name: "Onboarding", icon: "user-plus", what_it_runs: "A first-week plan when someone is hired", purpose: "A row is a new starter's plan.", data: [], pages: [], rules: [] },
    { name: "Tools and budgets", icon: "wrench", what_it_runs: "Software seats and vendor budgets", purpose: "A row is a vendor.", data: ["vendors.csv"], pages: [], rules: [] },
    { name: "Spend", icon: "wallet", what_it_runs: "Expenses and purchases", purpose: "A row is an expense.", data: ["expenses.csv"], pages: [{ file: "Fernwood policies.pdf", pages: [4, 5] }], rules: ["An expense over $500 needs Lena's approval.", "Remind the person 3 days after an expense is rejected."] },
    { name: "Time off", icon: "calendar", what_it_runs: "Requests, balances and holidays", purpose: "A row is a request.", data: ["leave.csv"], pages: [], rules: [] },
    { name: "Customer contracts", icon: "file-pen-line", what_it_runs: "Contracts and renewals", purpose: "A row is a contract.", data: ["contracts.csv"], pages: [], rules: [] },
  ],
  connections: [
    { from: "Hiring", to: "Onboarding", says: "Hired starts a plan in Onboarding" },
    { from: "Onboarding", to: "Tools and budgets", says: "a new starter gets seats in Tools and budgets" },
    { from: "Customer contracts", to: "Spend", says: "a renewal starts a request in Spend" },
  ],
  not_carried_over: [{ item: "Zoho “Project code” column", why: "No policy uses it. Left in the export, not imported." }],
  holidays: [],
  flags: [],
};
