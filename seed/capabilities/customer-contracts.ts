// Customer contracts as 6a–6b, 7a–7e and 8c show it, at version 4 (the Legal review change, v5, is made in M6).
// v1 came from chat on Aug 12 with 1 sheet ("Created Aug 12 from your message"); the contracts were imported,
// and Renewals (v2), Contacts (v3) and the signed-PDF AI step (v4) were added, on the afternoon of Oct 21.
import type { CapabilityFile, Rule, Sheet } from "@/server/kernel/schema/file";
import type { Seeder } from "./seeder";

const $ = (dollars: number) => dollars * 100;

const contracts: Sheet = {
  id: "contracts",
  name: "Contracts",
  kind: "list",
  row: { one: "contract", many: "contracts" },
  addAction: "New contract",
  titleColumn: "customer",
  sort: { column: "renews_on", dir: "asc" },
  // The record's tabs (0.3): a contract is added from its customer and value, the rest filled in later.
  form: {
    tabs: [
      { name: "Basics", sections: [{ name: null, columns: ["customer", "value", "owner"] }] },
      { name: "Dates", sections: [{ name: "Term", columns: ["start", "renews_on"] }, { name: "Notice", columns: ["notice"] }] },
      { name: "Documents", sections: [{ name: null, columns: ["signed_contract"] }] },
    ],
  },
  columns: [
    { id: "customer", name: "Customer", type: "text", required: true },
    { id: "value", name: "Value a year", type: "money", required: true },
    { id: "start", name: "Start", type: "date" },
    { id: "renews_on", name: "Renews on", type: "date", default: { kind: "expr", expr: { op: "date_add", args: [{ col: "start" }, 1, "years"] } } },
    { id: "notice", name: "Notice", type: "days", default: { kind: "value", value: 30 } },
    // The reminders count from it (7a: "notice date Oct 15").
    {
      id: "notice_date",
      name: "Notice date",
      type: "computed",
      result: "date",
      hintFor: "notice",
      expr: { op: "date_add", args: [{ col: "renews_on" }, { op: "mul", args: [{ col: "notice" }, -1] }, "days"] },
    },
    { id: "owner", name: "Owner", type: "person", default: { kind: "creator" } },
    { id: "signed_contract", name: "Signed contract", type: "file" },
    { id: "status", name: "Status", type: "step" },
  ],
  steps: [
    { id: "draft", name: "Draft", start: true, tone: "grey" },
    { id: "signed", name: "Signed", tone: "blue" },
    { id: "active", name: "Active", tone: "green" },
    { id: "renewal_due", name: "Renewal due", tone: "orange" },
    { id: "renewed", name: "Renewed", end: "final", button: "Mark renewed", tone: "done" },
    { id: "ended", name: "Ended", end: "exit", button: "End contract", tone: "done" },
  ],
};

const renewals: Sheet = {
  id: "renewals",
  name: "Renewals",
  kind: "list",
  row: { one: "renewal", many: "renewals" },
  titleColumn: "contract",
  columns: [
    { id: "contract", name: "Contract", type: "link", link: { sheet: "contracts" }, required: true },
    { id: "due", name: "Due", type: "date" },
    { id: "new_value", name: "New value a year", type: "money" },
    { id: "decision", name: "Decision", type: "choice", options: [{ id: "renew", name: "Renew" }, { id: "end", name: "End" }] },
    { id: "notes", name: "Notes", type: "long_text" },
  ],
};

const contacts: Sheet = {
  id: "contacts",
  name: "Contacts",
  kind: "list",
  row: { one: "contact", many: "contacts" },
  titleColumn: "name",
  columns: [
    { id: "contract", name: "Contract", type: "link", link: { sheet: "contracts" }, required: true },
    { id: "name", name: "Name", type: "text", required: true },
    { id: "role", name: "Role", type: "text" },
    { id: "email", name: "Email", type: "email" },
    { id: "phone", name: "Phone", type: "phone" },
  ],
};

const rules = (s: Seeder): Rule[] => [
  {
    id: "remind_owner",
    text: "60 days before a contract’s notice date, move it to Renewal due and remind its owner.",
    reading: { when: "60 days before a contract’s notice date", then: "It moves to Renewal due and its owner is reminded" },
    trigger: { kind: "date_reached", sheet: "contracts", date: "notice_date", offsetDays: -60 },
    // It waits on its owner at Renewal due (8c), and they are emailed.
    actions: [
      { kind: "ask_person", column: "owner", step: "renewal_due", label: "Decide on the renewal" },
      { kind: "notify", columns: ["owner"], message: "This contract is due for renewal." },
    ],
    enabled: true,
  },
  {
    id: "tell_wade",
    text: "30 days before the notice date, if it is still in Renewal due, tell Wade and the owner.",
    reading: { when: "30 days before the notice date, while it is in Renewal due", then: "Wade and the owner are told" },
    trigger: { kind: "date_reached", sheet: "contracts", date: "notice_date", offsetDays: -30 },
    condition: { op: "eq", args: [{ col: "status" }, "renewal_due"] },
    actions: [{ kind: "notify", people: [s.p("wade")], columns: ["owner"], message: "This contract is still waiting for a renewal decision." }],
    enabled: true,
  },
];

const READ_PDF: Rule = {
  id: "read_signed_pdf",
  text: "When a signed PDF is added, an AI step reads it and fills the row for the owner to confirm; then it moves to Signed.",
  reading: { when: "A signed PDF is added", then: "An AI step reads it and fills the row for the owner to confirm; then it moves to Signed" },
  trigger: { kind: "field_changed", sheet: "contracts", field: "signed_contract" },
  condition: { op: "not", args: [{ op: "empty", args: [{ col: "signed_contract" }] }] },
  actions: [
    { kind: "ai_step", question: "Read the signed contract and fill in the customer, the value a year, the start date and the notice period." },
    { kind: "move_to_step", step: "signed" },
  ],
  enabled: true,
};

function file(s: Seeder, version: 1 | 2 | 3 | 4): CapabilityFile {
  const sheets = [contracts, ...(version >= 2 ? [renewals] : []), ...(version >= 3 ? [contacts] : [])];
  const viaContract = { via: "contract", column: "owner" };
  return {
    name: "Customer contracts",
    icon: "file-pen-line",
    sheets,
    roles: [
      {
        id: "managers",
        name: "Contract managers",
        members: { kind: "people", people: [s.p("wade"), s.p("krishna")] },
        can: ["see", "add", "edit", "delete", "move_steps", "customize"],
        scope: "all",
      },
      {
        id: "owners",
        name: "Contract owners",
        members: { kind: "column", sheet: "contracts", column: "owner" },
        can: ["see", "edit", "move_steps"],
        scope: "own",
        scopeColumns: {
          contracts: { column: "owner" },
          ...(version >= 2 ? { renewals: viaContract } : {}),
          ...(version >= 3 ? { contacts: viaContract } : {}),
        },
        // 8c: the contracts you own.
        view: {
          sheet: "contracts",
          line: "The contracts you own",
          columns: [{ column: "customer" }, { column: "renews_on" }, { column: "notice" }, { column: "value" }, { column: "status" }],
        },
      },
    ],
    rules: version >= 4 ? [...rules(s), READ_PDF] : rules(s),
    // From the plan (developer notes §8); each went once it was built.
    later: [
      ...(version < 3 ? ["A Contacts sheet linked to each contract"] : []),
      ...(version < 4 ? ["An AI step that reads signed PDFs into the row"] : []),
    ],
  };
}

type Contract = [customer: string, value: number, start: string | null, renewsOn: string | null, notice: number, owner: string, status: string];

// 6a's ten rows, Fieldstone (8c), and Cedar Freight: 6a's total ($296,400) less the others leaves $24,000.
const CONTRACTS: Contract[] = [
  ["Northwind", 38_400, "2025-11-15", "2026-11-14", 30, "krishna", "renewal_due"],
  ["Acme Health", 28_800, "2025-11-29", "2026-11-28", 30, "krishna", "active"], // the 60-day rule moves it to Renewal due on Oct 22
  ["Pinecone Labs", 19_200, "2025-12-04", "2026-12-03", 60, "rita", "active"],
  ["Orbit Health", 14_400, "2026-01-10", "2027-01-09", 30, "rita", "active"],
  ["Brightline", 57_600, "2025-02-03", "2027-02-02", 90, "krishna", "active"],
  ["Kova", 10_800, "2026-03-10", "2027-03-09", 30, "rita", "active"],
  ["Lumen Retail", 24_000, "2026-04-01", "2027-03-31", 60, "krishna", "active"],
  ["Harbor Logistics", 31_200, "2026-06-15", "2027-06-14", 60, "krishna", "active"],
  ["Sable Analytics", 18_000, "2026-10-01", "2027-09-30", 30, "rita", "signed"],
  ["Fieldstone", 18_000, "2026-08-03", "2027-08-02", 30, "rita", "active"],
  ["Cedar Freight", 24_000, "2026-10-15", "2027-10-14", 30, "krishna", "active"],
];

// 18 contacts; Orbit Health, Kova and Quill Media have one each (7e: "Their 3 contacts"). Three have no email (4e).
const CONTACTS: [customer: string, name: string, role: string, email: string | null][] = [
  ["Northwind", "Dana Whitfield", "Head of operations", "dana@northwind.com"],
  ["Northwind", "Accounts payable", "Billing", "ap@northwind.com"],
  ["Acme Health", "Ravi Shah", "Procurement", "ravi.shah@acmehealth.com"],
  ["Acme Health", "Billing team", "Billing", null],
  ["Pinecone Labs", "Marta Lind", "CTO", "marta@pineconelabs.io"],
  ["Pinecone Labs", "Finance", "Billing", "finance@pineconelabs.io"],
  ["Orbit Health", "Sean Doyle", "IT director", "sdoyle@orbithealth.com"],
  ["Brightline", "Priscilla Moore", "VP engineering", "pmoore@brightline.co"],
  ["Brightline", "Legal", "Contracts", "legal@brightline.co"],
  ["Kova", "Jun Park", "Founder", "jun@kova.app"],
  ["Lumen Retail", "Elena Ruiz", "Platform lead", "elena.ruiz@lumenretail.com"],
  ["Lumen Retail", "Accounts", "Billing", null],
  ["Harbor Logistics", "Tom Becker", "Engineering manager", "tbecker@harborlogistics.com"],
  ["Harbor Logistics", "Finance office", "Billing", "finance@harborlogistics.com"],
  ["Sable Analytics", "Amara Obi", "Data lead", "amara@sableanalytics.com"],
  ["Fieldstone", "Chris Hale", "Operations", "chris@fieldstone.io"],
  ["Cedar Freight", "Billing desk", "Billing", null],
  ["Quill Media", "Nora Quill", "Managing editor", "nora@quillmedia.com"],
];

export async function seedCustomerContracts(s: Seeder) {
  const cap = await s.create(file(s, 1), "2026-08-12T16:02:12Z", { owner: "wade", source: "plan" });

  // Every contract has its signed file (9d: "12 signed files").
  const signed = new Map<string, string>();
  for (const [customer, , start] of [...CONTRACTS, ["Quill Media", 0, null] as const])
    signed.set(customer, await s.upload(`${customer.replace(/\s+/g, "-")}-MSA-${(start ?? "2026").slice(0, 4)}.pdf`, "wade", "2026-10-21T16:02:20Z"));

  const ids = await s.import(
    cap,
    "contracts",
    CONTRACTS.map(([customer, value, start, renewsOn, notice, owner, status]) => ({
      values: { customer, value: $(value), start, renews_on: renewsOn, notice, owner: s.p(owner), signed_contract: signed.get(customer), status },
    })),
    "contracts.csv",
    "2026-10-21T16:02:31Z",
    { decided: ["Sable Analytics", "Brightline"] },
  );
  const id = new Map(CONTRACTS.map(([customer], i) => [customer, ids[i]!]));

  await s.change(cap, file(s, 2), "2026-10-21T16:20:00Z", "sheet added “Renewals”");
  await s.import(
    cap,
    "renewals",
    [
      { values: { contract: id.get("Northwind"), due: "2026-11-14", new_value: $(41_000) } },
      { values: { contract: id.get("Acme Health"), due: "2026-11-28" } },
      { values: { contract: id.get("Pinecone Labs"), due: "2026-12-03" } },
      { values: { contract: id.get("Orbit Health"), due: "2027-01-09" } },
    ],
    "contracts.csv",
    "2026-10-21T16:20:30Z",
  );

  await s.change(cap, file(s, 3), "2026-10-21T16:40:00Z", "sheet added “Contacts”");
  await s.change(cap, file(s, 4), "2026-10-21T17:00:00Z", "rule added “When a signed PDF is added, an AI step reads it”");

  // Quill Media was added by hand after the import (9a).
  id.set("Quill Media", await s.add("wade", cap, "contracts", { customer: "Quill Media", value: $(12_000), owner: s.p("rita"), signed_contract: signed.get("Quill Media") }, "2026-10-21T17:20:02Z"));

  await s.import(
    cap,
    "contacts",
    CONTACTS.map(([customer, name, role, email]) => ({ values: { contract: id.get(customer), name, role, email } })),
    "contracts.csv",
    "2026-10-21T17:21:00Z",
  );
  return cap;
}
