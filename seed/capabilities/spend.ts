// Spend (4e: expenses and purchases, owned by Lena; Lena sees all, each person their own), as 8b, 8g and 8h
// show it. Purchases are documents with lines (5j matches bills to purchase lines). The purchases behind the
// reports in 11c–11g are seeded in M8.
import type { CapabilityFile } from "@/server/kernel/schema/file";
import type { Seeder } from "./seeder";

const TEAMS = [
  { id: "engineering", name: "Engineering" },
  { id: "marketing", name: "Marketing" },
  { id: "sales", name: "Sales" },
  { id: "operations", name: "Operations" },
  { id: "people", name: "People" },
];

function file(s: Seeder): CapabilityFile {
  return {
    name: "Spend",
    icon: "wallet",
    description: "Expenses and purchases",
    sheets: [
      {
        id: "purchases",
        name: "Purchases",
        kind: "document",
        row: { one: "purchase", many: "purchases" },
        addAction: "Request a purchase",
        titleColumn: "what",
        columns: [
          { id: "what", name: "What", type: "text", required: true },
          { id: "team", name: "Team", type: "choice", options: TEAMS },
          { id: "requested_by", name: "Requested by", type: "person", default: { kind: "creator" } },
          { id: "date", name: "Date", type: "date", default: { kind: "today" } },
          { id: "supplier", name: "Supplier", type: "text" },
          { id: "total", name: "Total", type: "computed", result: "money", expr: { sumOf: { sheet: "purchase_lines", column: "amount" } } },
          { id: "status", name: "Status", type: "step" },
        ],
        steps: [
          { id: "submitted", name: "Submitted", start: true, tone: "yellow" },
          { id: "approved", name: "Approved", moveIn: "not_submitter", tone: "green" },
          { id: "ordered", name: "Ordered", tone: "blue" },
          { id: "received", name: "Received", end: "final", tone: "done" },
          { id: "rejected", name: "Rejected", end: "exit", moveIn: "not_submitter", tone: "grey" },
        ],
      },
      {
        id: "purchase_lines",
        name: "Purchase lines",
        kind: "lines",
        row: { one: "line", many: "lines" },
        parentSheet: "purchases",
        titleColumn: "item",
        columns: [
          { id: "item", name: "Item", type: "text", required: true },
          { id: "quantity", name: "Quantity", type: "number", min: 1, required: true },
          { id: "unit_price", name: "Unit price", type: "money", required: true },
          { id: "amount", name: "Amount", type: "computed", result: "money", expr: { op: "mul", args: [{ col: "quantity" }, { col: "unit_price" }] } },
        ],
      },
      {
        id: "expenses",
        name: "Expenses",
        kind: "list",
        row: { one: "expense", many: "expenses" },
        addAction: "Add an expense",
        sort: { column: "status", dir: "asc", then: { column: "date", dir: "desc" } }, // 8a, 8b: by step, newest first
        titleColumn: "what",
        form: {
          tabs: [
            { name: "Basics", sections: [{ name: null, columns: ["what", "who", "date", "amount", "category", "note"] }] },
            { name: "Payment", sections: [{ name: null, columns: ["paid_with", "receipt", "paid_on"] }] },
          ],
        },
        columns: [
          { id: "what", name: "What for", type: "text", required: true },
          { id: "who", name: "Who", type: "person", required: true, default: { kind: "creator" } },
          { id: "date", name: "Date", type: "date", required: true },
          { id: "amount", name: "Amount", type: "money", required: true },
          {
            id: "category",
            name: "Category",
            type: "choice",
            options: [
              { id: "meals", name: "Meals" },
              { id: "travel", name: "Travel" },
              { id: "software", name: "Software" },
              { id: "cloud", name: "Cloud" },
              { id: "office", name: "Office" },
              { id: "other", name: "Other" },
            ],
          },
          { id: "paid_with", name: "Paid with", type: "choice", options: [{ id: "own_card", name: "My own card" }, { id: "company_card", name: "Company card" }] },
          { id: "receipt", name: "Receipt", type: "file" },
          { id: "paid_on", name: "Paid on", type: "date" },
          { id: "note", name: "Note", type: "text" },
          { id: "status", name: "Status", type: "step" },
        ],
        steps: [
          // An expense without its receipt waits on the person who submitted it, not on Finance (8b, 8h).
          { id: "needs_receipt", name: "Needs a receipt", start: true, moveOut: "submitter", tone: "yellow" },
          { id: "submitted", name: "Submitted", tone: "yellow" },
          { id: "approved", name: "Approved", moveIn: "not_submitter", tone: "green" },
          { id: "paid", name: "Paid", end: "final", tone: "done" },
          { id: "rejected", name: "Rejected", end: "exit", moveIn: "not_submitter", tone: "grey" },
        ],
      },
    ],
    roles: [
      {
        id: "finance",
        name: "Finance",
        members: { kind: "people", people: [s.p("lena"), s.p("wade")] },
        can: ["see", "add", "edit", "delete", "move_steps", "customize"],
        scope: "all",
      },
      {
        id: "requesters",
        name: "Requesters",
        members: { kind: "everyone" },
        can: ["see", "add", "edit", "move_steps"],
        moveFrom: ["needs_receipt"],
        scope: "own",
        scopeColumns: { purchases: { column: "requested_by" }, expenses: { column: "who" } },
        // 8b, 8g: your own expenses, and the form with its receipt first.
        view: {
          sheet: "expenses",
          line: "Your own expenses",
          columns: [{ column: "what" }, { column: "date", name: "When", hint: "note" }, { column: "amount" }, { column: "status", hint: "paid_on" }],
          form: ["receipt", "what", ["date", "amount"], ["category", "paid_with"]],
        },
      },
      { id: "approvers", name: "Purchase approvers", members: { kind: "people", people: [s.p("krishna")] }, can: ["see", "move_steps"], sheets: ["purchases"], scope: "all" },
    ],
    rules: [
      // An expense added with its receipt goes straight on; one whose receipt comes later goes on then.
      ...(["row_created", "field_changed"] as const).map((kind) => ({
        id: kind === "row_created" ? "added_with_receipt" : "receipt_attached",
        text: kind === "row_created" ? "An expense added with its receipt is Submitted." : "When a receipt is attached to an expense that needs one, it is Submitted.",
        reading: { when: kind === "row_created" ? "An expense is added with its receipt" : "A receipt is attached to an expense that needs one", then: "It moves to Submitted" },
        trigger: { kind, sheet: "expenses", ...(kind === "field_changed" ? { field: "receipt" } : {}) },
        condition: { op: "and" as const, args: [{ op: "eq" as const, args: [{ col: "status" }, "needs_receipt"] }, { op: "not" as const, args: [{ op: "empty" as const, args: [{ col: "receipt" }] }] }] },
        actions: [{ kind: "move_to_step" as const, step: "submitted" }],
        enabled: true,
      })),
      {
        id: "to_lena",
        text: "Submitted expenses wait on Lena to approve them.",
        reading: { when: "An expense is Submitted", then: "It waits on Lena to approve or reject it" },
        trigger: { kind: "enters_step", sheet: "expenses", step: "submitted" },
        actions: [{ kind: "ask_person", person: s.p("lena"), step: "submitted", label: "Approve or reject" }],
        enabled: true,
      },
      // 8h: Lena confirms what an AI step suggests; nothing is saved until she does.
      {
        id: "suggest_category",
        text: "An expense without a category: an AI step suggests one, Lena confirms.",
        reading: { when: "An expense without a category is Submitted", then: "An AI step suggests a category; Lena confirms it" },
        trigger: { kind: "enters_step", sheet: "expenses", step: "submitted" },
        condition: { op: "empty" as const, args: [{ col: "category" }] },
        actions: [{ kind: "ai_step", question: "Which category is this expense?", column: "category", person: s.p("lena") }],
        enabled: true,
      },
    ],
    later: [],
  };
}

const $ = (dollars: number) => Math.round(dollars * 100);

export async function seedSpend(s: Seeder) {
  const cap = await s.create(file(s), "2026-10-12T09:20:03Z", { owner: "lena" });

  // 8b: Maya's own expenses.
  type Expense = { what: string; who: string; date: string; amount: number; category?: string; paid_on?: string; note?: string; status: string };
  const MAYA: Expense[] = [
    { what: "Taxi to SFO", who: "maya", date: "2026-10-09", amount: 82, category: "travel", status: "needs_receipt" },
    { what: "Seattle trip", who: "maya", date: "2026-09-30", amount: 520, category: "travel", paid_on: "2026-10-16", note: "Sep 30 – Oct 2, 4 receipts", status: "approved" },
    { what: "Keyboard", who: "maya", date: "2026-10-03", amount: 140, category: "office", paid_on: "2026-10-09", status: "paid" },
    { what: "Conference books", who: "maya", date: "2026-09-18", amount: 64, category: "other", paid_on: "2026-09-25", status: "paid" },
    { what: "Team lunch", who: "maya", date: "2026-08-28", amount: 148, category: "meals", paid_on: "2026-09-04", note: "for 6 people", status: "paid" },
  ];
  // 8h: 18 expenses from Zoho with no category; the first five are on the screen.
  const NO_CATEGORY: [what: string, who: string, date: string, amount: number][] = [
    ["Figma, annual seat", "omar", "2026-09-22", 180],
    ["Uber, Oct 3", "dev", "2026-10-03", 46],
    ["AWS, September", "kim", "2026-09-30", 1_240],
    ["Team lunch", "priya", "2026-09-25", 212],
    ["Amazon order 114-2290", "jon", "2026-09-19", 89],
    ["Client dinner, Kova", "rita", "2026-09-17", 164],
    ["Train to Dallas", "leo", "2026-09-11", 58],
    ["Canva Pro", "nina", "2026-09-08", 120],
    ["Office plants", "krishna", "2026-09-04", 75],
    ["Coffee for interviews", "aisha", "2026-09-02", 38],
    ["Postage", "lena", "2026-08-29", 22],
    ["Lyft, Aug 27", "dev", "2026-08-27", 31],
    ["Notion, team plan", "omar", "2026-08-21", 96],
    ["Datadog, extra hosts", "kim", "2026-08-18", 310],
    ["HDMI adapters", "jon", "2026-08-14", 54],
    ["Conference ticket", "priya", "2026-08-10", 450],
    ["Domain renewal", "wade", "2026-08-06", 24],
    ["Parking, Austin", "rita", "2026-08-03", 18],
  ];
  // Maya added her two newest by hand from the form (so expenses are what she does most, 3a1); Lena approved
  // the Seattle trip. The rest came over in the import.
  const BY_HAND = new Set(["Taxi to SFO", "Seattle trip"]);
  const rows = [
    ...MAYA.filter((e) => !BY_HAND.has(e.what)).map((e) => ({ ...e, paid_with: "own_card" })),
    ...NO_CATEGORY.map(([what, who, date, amount]) => ({ what, who, date, amount, status: "submitted" })),
  ];
  await s.import(
    cap,
    "expenses",
    rows.map(({ who, amount, ...rest }) => ({ values: { ...rest, who: s.p(who), amount: $(amount) } })),
    "expenses.csv",
    "2026-10-12T09:20:30Z",
  );

  const byHand = (what: string) => {
    const { who, amount, status: _status, ...rest } = MAYA.find((e) => e.what === what)!;
    return { ...rest, who: s.p(who), amount: $(amount), paid_with: "own_card" };
  };
  const seattle = await s.add("maya", cap, "expenses", byHand("Seattle trip"), "2026-10-13T16:40:00Z");
  await s.move("maya", seattle, "submitted", "2026-10-13T16:41:00Z");
  await s.move("lena", seattle, "approved", "2026-10-15T10:12:00Z");
  await s.add("maya", cap, "expenses", byHand("Taxi to SFO"), "2026-10-14T08:05:00Z");
  return cap;
}
