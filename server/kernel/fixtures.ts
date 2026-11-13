// Small capability files for kernel tests. Not used by the app.
import type { CapabilityFile } from "./schema/file";

export const PEOPLE = {
  wade: "00000000-0000-4000-8000-000000000001",
  krishna: "00000000-0000-4000-8000-000000000002",
};

// One list sheet, a step flow with an exit, a final step and an onlyWhen step, and two roles.
export function contractsFile(managers: string[] = [PEOPLE.wade]): CapabilityFile {
  return {
    name: "Customer contracts",
    icon: "file-pen-line",
    sheets: [
      {
        id: "contracts",
        name: "Contracts",
        kind: "list",
        titleColumn: "customer",
        columns: [
          { id: "customer", name: "Customer", type: "text", required: true },
          { id: "value", name: "Value a year", type: "money", required: true },
          { id: "start", name: "Start", type: "date" },
          { id: "renews", name: "Renews on", type: "date", default: { kind: "expr", expr: { op: "date_add", args: [{ col: "start" }, 1, "years"] } } },
          { id: "notice", name: "Notice", type: "days", default: { kind: "value", value: 30 } },
          { id: "owner", name: "Owner", type: "person", default: { kind: "creator" } },
          { id: "days_left", name: "Days left", type: "computed", result: "days", expr: { op: "days_until", args: [{ col: "renews" }] } },
          { id: "status", name: "Status", type: "step" },
        ],
        steps: [
          { id: "draft", name: "Draft", start: true },
          { id: "signed", name: "Signed" },
          { id: "legal", name: "Legal review", onlyWhen: { op: "gt", args: [{ col: "value" }, 5_000_000] } },
          { id: "active", name: "Active" },
          { id: "ended", name: "Ended", end: "exit" },
          { id: "renewed", name: "Renewed", end: "final" },
        ],
      },
    ],
    roles: [
      { id: "managers", name: "Contract managers", members: { kind: "people", people: managers }, can: ["see", "add", "edit", "delete", "move_steps", "customize"], scope: "all" },
      {
        id: "owners",
        name: "Contract owners",
        members: { kind: "column", sheet: "contracts", column: "owner" },
        can: ["see", "edit", "move_steps"],
        scope: "own",
        scopeColumns: { contracts: { column: "owner" } },
      },
    ],
    rules: [],
    later: [],
  };
}

// Money received, which payments allocate to orders in another capability.
export function receiptsFile(admins: string[] = [PEOPLE.wade]): CapabilityFile {
  return {
    name: "Receipts",
    icon: "wallet",
    sheets: [
      {
        id: "receipts",
        name: "Receipts",
        kind: "list",
        titleColumn: "payer",
        columns: [
          { id: "payer", name: "Payer", type: "text", required: true },
          { id: "received", name: "Received", type: "money", required: true },
        ],
      },
    ],
    roles: [{ id: "admins", name: "Admins", members: { kind: "people", people: admins }, can: ["see", "add", "edit", "delete"], scope: "all" }],
    rules: [],
    later: [],
  };
}

// A document with lines and totals, and payments allocated from receipts (another capability) to orders.
export function ordersFile(receiptsId: string, admins: string[] = [PEOPLE.wade]): CapabilityFile {
  return {
    name: "Orders",
    icon: "receipt",
    sheets: [
      {
        id: "orders",
        name: "Orders",
        kind: "document",
        titleColumn: "ref",
        columns: [
          { id: "ref", name: "Order", type: "text", required: true },
          { id: "total", name: "Total", type: "computed", result: "money", expr: { sumOf: { sheet: "lines", column: "amount" } } },
          { id: "paid", name: "Paid", type: "computed", result: "money", expr: { sumOf: { sheet: "payments", column: "amount", by: "order" } } },
          { id: "open", name: "Open amount", type: "computed", result: "money", expr: { op: "sub", args: [{ col: "total" }, { col: "paid" }] } },
        ],
      },
      {
        id: "lines",
        name: "Lines",
        kind: "lines",
        parentSheet: "orders",
        titleColumn: "item",
        columns: [
          { id: "item", name: "Item", type: "text", required: true },
          { id: "qty", name: "Quantity", type: "number", min: 1, required: true },
          { id: "price", name: "Price", type: "money", required: true },
          { id: "amount", name: "Amount", type: "computed", result: "money", expr: { op: "mul", args: [{ col: "qty" }, { col: "price" }] } },
        ],
      },
      {
        id: "payments",
        name: "Payments",
        kind: "allocation",
        titleColumn: "note",
        allocation: { from: "receipt", to: "order", amount: "amount", fromLimit: "received", toLimit: "total" },
        columns: [
          { id: "note", name: "Note", type: "text" },
          { id: "receipt", name: "Receipt", type: "link", link: { capability: receiptsId, sheet: "receipts" }, required: true },
          { id: "order", name: "Order", type: "link", link: { sheet: "orders" }, required: true },
          { id: "amount", name: "Amount", type: "money", required: true },
        ],
      },
    ],
    roles: [{ id: "admins", name: "Admins", members: { kind: "people", people: admins }, can: ["see", "add", "edit", "delete"], scope: "all" }],
    rules: [],
    later: [],
  };
}

// Sales leads as Bike built it on a pilot copy (C1): one sheet, Lead owners see their own leads by Owner, Sales
// managers see every lead. The capability every Customize "add a sheet" request first failed on.
export function salesLeadsFile(managers: string[] = [PEOPLE.wade]): CapabilityFile {
  return {
    name: "Sales leads",
    icon: "handshake",
    sheets: [
      {
        id: "leads",
        name: "Leads",
        kind: "list",
        row: { one: "lead", many: "leads" },
        titleColumn: "company",
        addAction: "New lead",
        columns: [
          { id: "company", name: "Company", type: "text", required: true },
          { id: "contact", name: "Contact", type: "text" },
          { id: "email", name: "Email", type: "email" },
          { id: "source", name: "Source", type: "choice", options: [{ id: "referral", name: "Referral" }, { id: "inbound", name: "Inbound" }, { id: "outbound", name: "Outbound" }, { id: "event", name: "Event" }] },
          { id: "expected_value_a_year", name: "Expected value a year", type: "money" },
          { id: "owner", name: "Owner", type: "person", default: { kind: "creator" } },
          { id: "next_follow_up", name: "Next follow-up", type: "date" },
          { id: "notes", name: "Notes", type: "long_text" },
          { id: "status", name: "Status", type: "step" },
        ],
        steps: [
          { id: "new", name: "New", start: true },
          { id: "contacted", name: "Contacted" },
          { id: "qualified", name: "Qualified" },
          { id: "proposal", name: "Proposal" },
          { id: "won", name: "Won", end: "final", button: "Mark won" },
          { id: "lost", name: "Lost", end: "exit", button: "Mark lost" },
        ],
      },
    ],
    roles: [
      { id: "sales_managers", name: "Sales managers", members: { kind: "people", people: managers }, can: ["see", "add", "edit", "delete", "move_steps", "customize"], scope: "all" },
      {
        id: "lead_owners",
        name: "Lead owners",
        members: { kind: "column", sheet: "leads", column: "owner" },
        can: ["see", "add", "edit", "move_steps"],
        scope: "own",
        scopeColumns: { leads: { column: "owner" } },
      },
    ],
    rules: [],
    later: ["A Contacts sheet for several people at one company", "A reminder to the owner when a follow-up date arrives"],
  };
}

// A capability at every limit (M25): 6 sheets of 40 questions each and 20 rules, as a school's admissions might be.
// For the prompt-size test, the bench's wide capability and the big-capability screens.
export function bigFile(admins: string[] = [PEOPLE.wade]): CapabilityFile {
  const TYPES = ["text", "long_text", "number", "money", "percent", "date", "datetime", "days", "email", "phone", "url", "file"] as const;
  const filler = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => {
      const n = from + i;
      return { id: `q${n}`, name: `Question ${n}`, type: TYPES[n % TYPES.length]! };
    });
  const applications = {
    id: "applications",
    name: "Applications",
    kind: "list" as const,
    titleColumn: "student",
    columns: [
      { id: "student", name: "Student", type: "text" as const, required: true },
      { id: "grade", name: "Grade", type: "choice" as const, options: Array.from({ length: 12 }, (_, i) => ({ id: `g${i + 1}`, name: `Grade ${i + 1}` })) },
      { id: "fee", name: "Fee", type: "money" as const },
      { id: "applied", name: "Applied on", type: "date" as const, default: { kind: "today" as const } },
      { id: "owner", name: "Counsellor", type: "person" as const, default: { kind: "creator" as const } },
      { id: "decision", name: "Decision", type: "choice" as const, options: [{ id: "yes", name: "Admit" }, { id: "no", name: "Decline" }] },
      { id: "days_open", name: "Days open", type: "computed" as const, result: "days" as const, expr: { op: "days_until" as const, args: [{ col: "applied" }] } },
      { id: "status", name: "Status", type: "step" as const },
      ...filler(9, 32),
    ],
    steps: [
      { id: "enquiry", name: "Enquiry", start: true as const },
      { id: "applied_s", name: "Applied" },
      { id: "documents", name: "Documents" },
      { id: "interaction", name: "Interaction" },
      { id: "offer", name: "Offer" },
      { id: "fee_due", name: "Fee due" },
      { id: "admitted", name: "Admitted", end: "final" as const },
      { id: "withdrawn", name: "Withdrawn", end: "exit" as const },
    ],
  };
  const child = (id: string, name: string) => ({
    id,
    name,
    kind: "list" as const,
    titleColumn: "title",
    columns: [
      { id: "title", name: "Title", type: "text" as const, required: true },
      { id: "application", name: "Application", type: "link" as const, link: { sheet: "applications" } },
      ...filler(3, 38),
    ],
  });
  const sheets = [applications, child("documents_s", "Documents"), child("interactions", "Interactions"), child("fees", "Fees"), child("contacts", "Contacts"), child("notes", "Notes")];
  const say = (n: number) => ({ text: `Rule ${n}`, reading: { when: `When ${n}`, then: `Then ${n}` }, enabled: true });
  const steps = ["applied_s", "documents", "interaction", "offer", "fee_due"];
  const rules = [
    ...steps.map((step, i) => ({ id: `notify_${step}`, ...say(i + 1), trigger: { kind: "enters_step" as const, sheet: "applications", step }, actions: [{ kind: "notify" as const, columns: ["owner"], message: `Now at step ${i + 2}` }] })),
    ...steps.map((step, i) => ({ id: `note_${step}`, ...say(i + 6), trigger: { kind: "enters_step" as const, sheet: "applications", step }, actions: [{ kind: "create_row_in" as const, target: { sheet: "notes" }, map: { title: { col: "student" }, application: { ref: "row" as const } } }] })),
    { id: "ask_offer", ...say(11), trigger: { kind: "enters_step" as const, sheet: "applications", step: "offer" }, actions: [{ kind: "ask_person" as const, person: admins[0]!, decision: { column: "decision", approve: "yes", decline: "no" } }] },
    { id: "welcome", ...say(12), trigger: { kind: "row_created" as const, sheet: "applications" }, actions: [{ kind: "notify" as const, columns: ["owner"], message: "A new application" }] },
    { id: "fee_changed", ...say(13), trigger: { kind: "field_changed" as const, sheet: "applications", field: "fee" }, actions: [{ kind: "notify" as const, people: admins, message: "The fee changed" }] },
    ...[7, 14, 30].map((d, i) => ({ id: `chase_${d}`, ...say(14 + i), trigger: { kind: "date_reached" as const, sheet: "applications", date: "applied", offsetDays: d }, actions: [{ kind: "notify" as const, columns: ["owner"], message: `${d} days since applying` }] })),
    ...["documents_s", "interactions", "fees", "contacts"].map((sheet, i) => ({ id: `new_${sheet}`, ...say(17 + i), trigger: { kind: "row_created" as const, sheet }, actions: [{ kind: "notify" as const, people: admins, message: `A new row in sheet ${i + 2}` }] })),
  ];
  return {
    name: "Admissions",
    icon: "graduation-cap",
    sheets,
    roles: [
      { id: "office", name: "Admissions office", members: { kind: "people", people: admins }, can: ["see", "add", "edit", "delete", "move_steps", "customize"], scope: "all" },
      { id: "counsellors", name: "Counsellors", members: { kind: "column", sheet: "applications", column: "owner" }, can: ["see", "edit", "move_steps"], sheets: ["applications"], scope: "own", scopeColumns: { applications: { column: "owner" } } },
    ],
    rules,
    later: [],
  };
}

// M28: Spend with a Cost centres sheet whose cost centres sit under each other (m28-a): Spent adds up the expenses
// that name one, Total spent adds the cost centres under it too. Each expense can name its cost centre.
export function costCentresVersion(spend: CapabilityFile): CapabilityFile {
  const file = structuredClone(spend);
  // Roles that see their own rows keep the sheets they had: a cost centre isn't anyone's own.
  for (const r of file.roles) if (r.scope !== "all" && !r.sheets) r.sheets = file.sheets.map((s) => s.id);
  file.sheets.push({
    id: "centres",
    name: "Cost centres",
    kind: "tree",
    tree: { parent: "under" },
    row: { one: "cost centre", many: "cost centres" },
    addAction: "Add a cost centre",
    titleColumn: "name",
    columns: [
      { id: "name", name: "Cost centre", type: "text", required: true },
      { id: "under", name: "Under", type: "link", link: { sheet: "centres" } },
      { id: "owner", name: "Owner", type: "person" },
      { id: "spent", name: "Spent", type: "computed", result: "money", expr: { sumOf: { sheet: "expenses", column: "amount", by: "centre" } } },
      { id: "total", name: "Total spent", type: "computed", result: "money", expr: { op: "add", args: [{ col: "spent" }, { sumOf: { sheet: "centres", column: "total", by: "under" } }] } },
    ],
  });
  const expenses = file.sheets.find((s) => s.id === "expenses")!;
  expenses.columns.push({ id: "centre", name: "Cost centre", type: "link", link: { sheet: "centres", pick: true } });
  expenses.form?.tabs[0]?.sections[0]?.columns.push("centre");
  // Everyone sees every cost centre, to pick one for an expense.
  file.roles.push({ id: "centre_readers", name: "Everyone", members: { kind: "everyone" }, can: ["see"], sheets: ["centres"], scope: "all" });
  return file;
}

// M32: Spend with the office rent repeating, as Customize leaves it after "Every month on the 1st, add the office rent
// to Expenses…" (m32-a): a rule with no row that adds an expense for Wade on the 1st of every month.
export function repeatsVersion(spend: CapabilityFile, wadeId: string): CapabilityFile {
  const file = structuredClone(spend);
  file.rules.push({
    id: "office_rent",
    text: "Every month on the 1st, add the office rent to Expenses: $2,400, Office, paid with the company card, for Wade.",
    reading: { when: "Every month on the 1st", then: "An expense is added: Office rent, $2,400, for Wade" },
    trigger: { kind: "repeats", sheet: "expenses", every: { unit: "month", day: 1 } },
    actions: [
      {
        kind: "create_row_in",
        target: { sheet: "expenses" },
        map: { what: "Office rent", who: wadeId, date: { ref: "today" }, amount: 240000, category: "office", paid_with: "company_card" },
      },
    ],
    enabled: true,
  });
  return file;
}

// M30: Spend with spending limits, as Customize leaves it after "Keep spending limits for each category…" (m30-d): a
// dated sheet kept by category, and a check that a new expense is within the limit in force on its date. Nothing moves.
export function spendingLimitsVersion(spend: CapabilityFile): CapabilityFile {
  const file = structuredClone(spend);
  const expenses = file.sheets.find((s) => s.id === "expenses")!;
  const category = expenses.columns.find((c) => c.id === "category")!;
  // Roles that see their own rows keep the sheets they had: a limit isn't anyone's own.
  for (const r of file.roles) if (r.scope !== "all" && !r.sheets) r.sheets = file.sheets.map((s) => s.id);
  file.sheets.push({
    id: "limits",
    name: "Spending limits",
    kind: "dated",
    dated: { key: "category", from: "from", until: "until" },
    row: { one: "limit", many: "limits" },
    addAction: "Add a spending limit",
    titleColumn: "category",
    columns: [
      { id: "category", name: "Category", type: "choice", options: structuredClone(category.options), required: true },
      { id: "from", name: "From", type: "date", required: true },
      { id: "limit", name: "Limit", type: "money", required: true },
      { id: "until", name: "Until", type: "date" },
    ],
  });
  const limit = { inForce: { sheet: "limits", is: "category", on: "date", value: "limit" } };
  expenses.checks = [
    ...(expenses.checks ?? []),
    { id: "within_limit", name: "Within the limit", condition: { op: "or", args: [{ op: "empty", args: [limit] }, { op: "lte", args: [{ col: "amount" }, limit] }] } },
  ];
  // Everyone sees every limit.
  file.roles.push({ id: "limit_readers", name: "Everyone", members: { kind: "everyone" }, can: ["see"], sheets: ["limits"], scope: "all" });
  return file;
}

// M29: Time off with a leave ledger, as Customize leaves it after "Keep leave in a ledger…" (m29-d): an approved
// request takes its days off as an entry, and Left counts the entries for the person. Used stays as the days taken
// before, so today's balances read the same.
export function leaveLedgerVersion(timeOff: CapabilityFile): CapabilityFile {
  const file = structuredClone(timeOff);
  file.sheets.push({
    id: "leave",
    name: "Leave entries",
    kind: "ledger",
    ledger: { account: "who", amount: "days", balance: "after", reverses: "reverses" },
    row: { one: "entry", many: "entries" },
    addAction: "New entry",
    titleColumn: "entry",
    columns: [
      { id: "entry", name: "Entry", type: "text", required: true },
      { id: "who", name: "Who", type: "person", required: true },
      { id: "days", name: "Days", type: "days", required: true },
      { id: "request", name: "Request", type: "link", link: { sheet: "requests" } },
      { id: "reverses", name: "Reverses", type: "link", link: { sheet: "leave" } },
      { id: "added", name: "Added", type: "date", default: { kind: "today" } },
      { id: "after", name: "Balance after", type: "days" },
    ],
  });
  // A request's Balance after is Left less its days until it's approved; then the entry has taken them off Left already.
  const after = file.sheets.find((s) => s.id === "requests")?.columns.find((c) => c.id === "balance_after");
  const leftNow = { lookup: { sheet: "balances", where: "who", is: "who", value: "left" } };
  if (after) after.expr = { op: "if", args: [{ op: "in", args: [{ col: "status" }, "approved", "taken"] }, leftNow, { op: "sub", args: [leftNow, { col: "days" }] }] };
  const left = file.sheets.find((s) => s.id === "balances")!.columns.find((c) => c.id === "left")!;
  left.expr = { op: "add", args: [{ op: "sub", args: [{ col: "allowance" }, { col: "used" }] }, { balanceOf: { sheet: "leave", of: "who" } }] };
  // Everyone sees their own entries, beside their own requests and balance, and adds none: only an approval does.
  file.roles.push({ id: "own_entries", name: "Everyone (own leave entries)", members: { kind: "everyone" }, can: ["see"], sheets: ["leave"], scope: "own", scopeColumns: { leave: { column: "who" } } });
  file.rules.push({
    id: "takes_days",
    text: "When a request is approved, a leave entry takes its days off.",
    reading: { when: "A request is approved", then: "A leave entry takes its days off" },
    trigger: { kind: "enters_step", sheet: "requests", step: "approved" },
    actions: [
      {
        kind: "create_row_in",
        target: { sheet: "leave" },
        map: { entry: "Approved request", who: { col: "who" }, days: { op: "sub", args: [0, { col: "days" }] }, request: { ref: "row" } },
      },
    ],
    enabled: true,
  });
  return file;
}

// M29: Stock, a ledger of office equipment moves (m29-c): Items, each with what is in stock, and Moves in and out,
// which can't take an item below zero. Jon and Wade keep it; everyone sees it.
export function stockFile(keepers: string[]): CapabilityFile {
  return {
    name: "Stock",
    icon: "package",
    description: "Office equipment, and moves in and out",
    sheets: [
      {
        id: "items",
        name: "Items",
        kind: "list",
        row: { one: "item", many: "items" },
        addAction: "New item",
        titleColumn: "name",
        columns: [
          { id: "name", name: "Item", type: "text", required: true },
          { id: "stock", name: "In stock", type: "computed", result: "number", expr: { balanceOf: { sheet: "moves" } } },
        ],
      },
      {
        id: "moves",
        name: "Moves",
        kind: "ledger",
        ledger: { account: "item", amount: "quantity", balance: "after", reverses: "reverses", min: 0 },
        row: { one: "move", many: "moves" },
        addAction: "New move",
        titleColumn: "move",
        columns: [
          { id: "move", name: "Move", type: "text", required: true },
          { id: "item", name: "Item", type: "link", link: { sheet: "items" }, required: true },
          { id: "quantity", name: "Quantity", type: "number", required: true },
          { id: "by", name: "By", type: "person", default: { kind: "creator" } },
          { id: "date", name: "Date", type: "date", default: { kind: "today" } },
          { id: "after", name: "In stock after", type: "number" },
          { id: "reverses", name: "Reverses", type: "link", link: { sheet: "moves" } },
        ],
      },
    ],
    roles: [
      { id: "keepers", name: "Stock keepers", members: { kind: "people", people: keepers }, can: ["see", "add", "edit", "delete", "customize"], scope: "all" },
      { id: "everyone", name: "Everyone", members: { kind: "everyone" }, can: ["see"], scope: "all" },
    ],
    rules: [],
    later: [],
  };
}
