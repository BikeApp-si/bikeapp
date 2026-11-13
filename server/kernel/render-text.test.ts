import { beforeAll, describe, expect, it } from "vitest";
import { people } from "@/db/schema";
import { seed } from "@/seed";
import { load } from "./context";
import { checkPlan, type CheckedPlan } from "./plans/plan";
import { alsoChanges, billRules, bills, contractRules, contracts } from "./plans/fixtures";
import { addedLines, columnText, renderCapabilityText, versionLine, type TextSection } from "./render-text";
import type { CapabilityFile } from "./schema/file";
import { applyChanges, type Change } from "./customize/changes";
import { PEOPLE, salesLeadsFile } from "./fixtures";
import { withWorkspace } from "./tx";

// The plan's side panel as plain text (5d, 5k): the same file always gives the same text.

const NEW = "00000000-0000-4000-8000-000000000009";
let files: Map<string, CapabilityFile>;
let emails: Map<string, string>;
let names: Map<string, string>;
let wade: string;
let allFiles: Map<string, CapabilityFile>; // every capability, Customer contracts included

beforeAll(async () => {
  const ws = (await seed()).fernwood.workspaceId;
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    const loaded = await load(tx);
    allFiles = new Map([...loaded.files].map(([id, f]) => [id, f.file]));
    files = new Map([...allFiles].filter(([, f]) => f.name !== "Customer contracts"));
    const all = await tx.select({ id: people.id, email: people.email, name: people.name }).from(people);
    emails = new Map(all.map((p) => [p.email, p.id]));
    names = new Map(all.map((p) => [p.id, p.name]));
    wade = emails.get("wade@fernwood.dev")!;
  });
});

const text = (plan: CheckedPlan, extras = {}) => {
  const all = new Map([...files, ...[...plan.edited].map(([id, e]) => [id, e.after] as const), [NEW, plan.file]]);
  return renderCapabilityText(plan.file, { capId: NEW, files: all, personName: (id) => names.get(id), viewerId: wade }, extras);
};
const asText = (s: TextSection[]) => s.map((x) => [x.heading, ...x.lines]);

describe("a capability as plain text", () => {
  it("reads 5d's Customer contracts plan", () => {
    const plan = checkPlan({ capability: contracts, rules: contractRules, alsoChanges: [] }, { newId: NEW, files, people: emails });
    expect(asText(text(plan, { suggested: ["At Renewal due, start a renewal request in Spend."] }))).toEqual([
      ["Contracts sheet", "Customer (text, required), Value a year (money, required), Start (date), Renews on (date, Start + 1 year), Notice (days, 30), Owner (person, you), Signed contract (file).", "The form: Basics (Customer, Value a year and Owner), Dates (Start, Renews on and Notice), Documents (Signed contract). Asked when creating: Customer and Value a year."],
      ["Steps", "Draft → Signed → Active → Renewal due → Renewed or Ended"],
      ["What happens by itself", "60 days before a contract’s notice date, move it to Renewal due and remind its owner.", "30 days before the notice date, if it is still in Renewal due, tell Wade and the owner."],
      ["Who can see and do what", "You and Krishna see every contract, add, edit and move them, and change how it works.", "Contract owners see their own contracts and can edit and move them.", "Everyone else sees nothing."],
      ["Connections (suggested)", "People fills Owner.", "At Renewal due, start a renewal request in Spend."],
      ["Later", "A Contacts sheet linked to each contract", "An AI step that reads signed PDFs into the row"],
      ["Coming soon", "Connections to other software"],
    ]);
  });

  it("reads 5f's tier, its Notice by tier, and Legal review only for large contracts", () => {
    const v2 = structuredClone(contracts);
    const sheet = v2.sheets[0]!;
    sheet.columns.splice(2, 0, { name: "Customer tier", type: "choice", required: true, default: null, options: ["Standard", "Enterprise"], link: null, formula: null, result: null });
    sheet.columns.find((c) => c.name === "Notice")!.default = { kind: "formula", value: JSON.stringify({ op: "if", args: [{ op: "eq", args: [{ col: "Customer tier" }, "Enterprise"] }, 90, 30] }) };
    sheet.steps.splice(1, 0, { name: "Legal review", start: false, end: null, button: null, only_when: JSON.stringify({ op: "gt", args: [{ col: "Value a year" }, 50000] }), move_out: "anyone", move_in: "anyone" });
    const plan = checkPlan({ capability: v2, rules: contractRules, alsoChanges: [] }, { newId: NEW, files, people: emails });
    const [sheetText, steps] = text(plan);
    expect(sheetText!.lines[0]).toContain("Customer tier (Standard or Enterprise, required)");
    expect(sheetText!.lines[0]).toContain("Notice (days: 90 for Enterprise, 30 for Standard)");
    expect(steps!.lines).toEqual(["Draft → Legal review, for contracts over $50,000 → Signed → Active → Renewal due → Renewed or Ended"]);
  });

  it("reads 5k's Supplier bills, with what it adds elsewhere and its connections", () => {
    const plan = checkPlan({ capability: bills, rules: billRules, alsoChanges }, { newId: NEW, files, people: emails });
    const added = [...plan.edited.values()].flatMap((e) => addedLines(e.before, e.after, (id) => names.get(id)));
    expect(added).toEqual([
      "Spend › Purchases: a new Billed step after Received.",
      "Spend › Purchase lines: a new Received quantity column.",
      "Tools and budgets › Budgets: a new Spent column.",
    ]);
    const s = asText(text(plan, { alsoChanges: added }));
    expect(s[0]).toEqual(["Bills sheet", "Supplier (text, required), Bill number (text, required), Amount (money, required), Due date (date), Purchase (a purchase in Spend, required), Budget (a budget in Tools and budgets), Bill (file).", "The form: Basics (Supplier, Bill number, Amount, Due date, Purchase and Budget), Documents (Bill). Asked when creating: Supplier, Bill number, Amount and Purchase."]);
    expect(s[1]).toEqual(["Steps", "Received → Matched → Approved → Paid"]);
    expect(s[3]).toEqual(["Who can see and do what", "You, Lena Ortiz and Krishna see every bill, add, edit and move them.", "Everyone sees the bills of their own purchases."]);
    expect(s.find((x) => x[0] === "Connections")).toEqual([
      "Connections",
      "Spend fills Purchase.",
      "Tools and budgets fills Budget.",
      "At Paid, Spend moves the purchase to Billed.",
      "At Paid, Tools and budgets adds the amount to Spent.",
    ]);
  });

  it("names who may move a step when it isn't anyone, under its sheet when there are two flows (Spend)", () => {
    const spend = [...files.values()].find((f) => f.name === "Spend")!;
    const id = [...files].find(([, f]) => f === spend)![0];
    const text = renderCapabilityText(spend, { capId: id, files, personName: (p) => names.get(p), viewerId: wade });
    expect(text.map((x) => x.heading)).not.toContain("Steps");
    const expenses = text.find((x) => x.heading === "Expenses sheet")!;
    // Its form first (0.3), then its steps.
    expect(expenses.lines[1]).toMatch(/^The form: Basics \(.*\), Payment \(.*\)\. Asked when creating: .*\.$/);
    expect(expenses.lines[2]).toMatch(/^Steps: .* → .*\.$/);
    expect(expenses.lines).toContain("Approved: not by the person who asked");
    expect(expenses.lines).toContain("Needs a receipt: only the person who asked moves it on");
  });
});

// Customize (6b, 6g): the capability as it is, naming people as People holds them.
describe("the Customize text", () => {
  const customize = (name: string) => {
    const [capId, file] = [...allFiles].find(([, f]) => f.name === name)!;
    return asText(renderCapabilityText(file, { capId, files: allFiles, personName: (id) => names.get(id), viewerId: null }));
  };

  it("reads Customer contracts at version 4 as on 6b, with its Renewals and Contacts sheets", () => {
    expect(customize("Customer contracts")).toEqual([
      ["Contracts sheet", "Customer (text, required), Value a year (money, required), Start (date), Renews on (date, Start + 1 year), Notice (days, 30), Owner (person, whoever adds it), Signed contract (file).", "The form: Basics (Customer, Value a year and Owner), Dates (Start, Renews on and Notice), Documents (Signed contract). Asked when creating: Customer and Value a year."],
      ["Renewals sheet", "Contract (one row from Contracts, required), Due (date), New value a year (money), Decision (Renew or End), Notes (long text)."],
      ["Contacts sheet", "Contract (one row from Contracts, required), Name (text, required), Role (text), Email (email), Phone (phone)."],
      ["Steps", "Draft → Signed → Active → Renewal due → Renewed or Ended"],
      [
        "What happens by itself",
        "60 days before a contract’s notice date, move it to Renewal due and remind its owner.",
        "30 days before the notice date, if it is still in Renewal due, tell Wade and the owner.",
        "When a signed PDF is added, an AI step reads it and fills the row for the owner to confirm; then it moves to Signed.",
      ],
      ["Who can see and do what", "Wade Wilson and Krishna see every contract, add, edit and move them, and change how it works.", "Contract owners see their own contracts and can edit and move them.", "Everyone else sees nothing."],
      ["Connections", "People fills Owner."],
      ["Coming soon", "Connections to other software"],
    ]);
  });

  it("reads Hiring as on 6g: steps under each sheet, Offer on Candidates, interviews with a date and time and a score from 1 to 4", () => {
    const text = customize("Hiring");
    expect(text.slice(0, 3)).toEqual([
      ["Openings sheet", "Role (text, required), Team (Engineering, Growth, Customer or Operations), Hiring manager (person), Salary band (money range), Opens on (date).", "Steps: Draft → Open → Filled or Closed."],
      [
        "Candidates sheet",
        "Name (text, required), Opening (one row from Openings), Source (Referral, Inbound or Agency), Referred by (person), CV (file), Offer (money), Offer approval (Approved or Declined), Start date (date).",
        "The form: Candidate (Name, Opening, Source, Referred by and CV), Offer (Offer, Offer approval and Start date). Asked when creating: Name.",
        "Steps: Applied → Screen → Interview → Offer → Hired or Rejected.",
      ],
      ["Interviews sheet", "Candidate (one row from Candidates, required), Interviewer (person), When (date and time), Score (1 to 4), Notes (long text)."],
    ]);
    expect(text.map((s) => s[0])).not.toContain("Steps");
    expect(text.find((s) => s[0] === "What happens by itself")).toContain("When a candidate moves to Interview, add three interviews and give each interviewer a scorecard task.");
  });

  it("gives the same text for the same file, every time", () => {
    const first = JSON.stringify(customize("Spend"));
    for (let i = 0; i < 20; i++) expect(JSON.stringify(customize("Spend"))).toBe(first);
  });
});

describe("the version line", () => {
  const now = new Date("2026-10-27T15:00:00Z");
  it("reads as 6b, 6c, 6d and 6e", () => {
    expect(versionLine({ version: 4, at: new Date("2026-10-21T22:00:00Z"), by: "Wade" }, now, "America/Chicago")).toBe("Version 4 · Oct 21 by Wade");
    expect(versionLine({ version: 5, at: new Date("2026-10-27T14:59:30Z"), by: "Wade" }, now, "America/Chicago")).toBe("Version 5 · just now by Wade");
    expect(versionLine({ version: 5, at: now, by: null }, now, "America/Chicago", "preview")).toBe("Preview of version 5");
    expect(versionLine({ version: 5, at: now, by: null }, now, "America/Chicago", "updating")).toBe("Updating to version 5");
    expect(versionLine({ version: 2, at: new Date("2025-03-01T12:00:00Z"), by: "Wade" }, now, "America/Chicago")).toBe("Version 2 · Mar 1, 2025 by Wade");
  });
});

// C1: a role Customize adds beside another for one sheet reads inside that role's sentence, never as a group of its own.
describe("a role beside another (C1)", () => {
  const who = (f: CapabilityFile) =>
    renderCapabilityText(f, { capId: "sales", files: new Map([["sales", f]]), personName: (id) => (id === PEOPLE.wade ? "Wade Wilson" : undefined), viewerId: null }).find((s) => s.heading === "Who can see and do what")!.lines;
  const companies = (): Change => ({ kind: "add_sheet", sheet: { id: "companies", name: "Companies", kind: "list", row: { one: "company", many: "companies" }, titleColumn: "name", columns: [{ id: "name", name: "Name", type: "text" }] } });

  it("joins what the main role sees when it allows the same", () => {
    const f = applyChanges(salesLeadsFile(), [companies(), { kind: "set_sheet_access", role: "lead_owners", sheet: "companies", sees: "all" }]);
    expect(who(f)).toEqual([
      "Wade Wilson sees every lead, add, edit and move them, and change how it works.",
      "Lead owners see their own leads and every company and can add, edit and move them.",
      "Everyone else sees nothing.",
    ]);
  });

  it("says it in a sentence of its own when it allows something else", () => {
    const f = applyChanges(salesLeadsFile(), [companies(), { kind: "set_sheet_access", role: "lead_owners", sheet: "companies", sees: "all" }]);
    f.roles.find((r) => r.id === "lead_owners_companies")!.can = ["see"];
    expect(who(f)[1]).toBe("Lead owners see their own leads and can add, edit and move them. They also see every company.");
  });

  it("leaves a role of its own alone, whatever its id looks like", () => {
    const f = applyChanges(salesLeadsFile(), [companies()]);
    f.roles.push({ id: "lead_owners_companies", name: "Company keepers", members: { kind: "everyone" }, can: ["see"], sheets: ["companies"], scope: "all" });
    expect(who(f)).toContain("Everyone sees every company.");
  });
});

describe("a link to another capability's sheet (M27)", () => {
  const sheet = (id: string, name: string) => ({ id, name, kind: "list" as const, titleColumn: "name", columns: [{ id: "name", name: "Name", type: "text" as const }] });
  const file = (name: string, sheets: ReturnType<typeof sheet>[]): CapabilityFile => ({ name, icon: "x", sheets, roles: [], rules: [], later: [] });
  const world = new Map([
    ["contracts", file("Customer contracts", [sheet("contracts", "Contracts")])],
    ["customers", file("Customers", [sheet("customers", "Customers")])],
    ["tools", file("Tools and budgets", [sheet("budgets", "Budgets")])],
  ]);
  const ctx = (viewerId: string | null) => ({ capId: "contracts", files: world, personName: () => undefined, viewerId });
  const on = world.get("contracts")!.sheets[0]!;

  it("names the capability once when it shares the sheet's name, and otherwise says where the rows live", () => {
    expect(columnText({ id: "customer", name: "Customer", type: "link", link: { capability: "customers", sheet: "customers" } }, on, ctx(null))).toBe("Customer (one row from Customers)");
    expect(columnText({ id: "budget", name: "Budget", type: "link", link: { capability: "tools", sheet: "budgets" } }, on, ctx(null))).toBe("Budget (one row from Budgets in Tools and budgets)");
    // A plan reads "a customer in Customers", unchanged.
    expect(columnText({ id: "customer", name: "Customer", type: "link", link: { capability: "customers", sheet: "customers" } }, on, ctx(wade))).toBe("Customer (a row in Customers)");
  });

  // E1 (G4's finding): a choice's or a person's default reads by its name, never its id.
  it("reads a default choice or person by name", () => {
    const named = { ...ctx(null), personName: (id: string) => (id === "p1" ? "Marko Novak" : undefined) };
    const billable = { id: "billable", name: "Billable", type: "choice" as const, options: [{ id: "yes", name: "Billable" }, { id: "no", name: "Not billable" }], default: { kind: "value" as const, value: "yes" } };
    expect(columnText(billable, on, named)).toBe("Billable (Billable or Not billable, Billable)");
    expect(columnText({ id: "partner", name: "Partner", type: "person", default: { kind: "value", value: "p1" } }, on, named)).toBe("Partner (person, Marko Novak)");
  });

  // E1 (G3's finding): a role that sees a sheet one link away names the row it links to.
  it("names the linked rows for a role that sees a sheet one link away", () => {
    const bills: CapabilityFile = {
      name: "Supplier bills",
      icon: "x",
      sheets: [{ id: "bills", name: "Bills", kind: "list", titleColumn: "name", row: { one: "bill", many: "bills" }, columns: [{ id: "name", name: "Name", type: "text" }, { id: "contract", name: "Contract", type: "link", link: { capability: "contracts", sheet: "contracts" } }] }],
      roles: [{ id: "all", name: "Everyone", members: { kind: "everyone" }, can: ["see"], scope: "team", scopeColumns: { bills: { column: "owner", via: "contract" } } }],
      rules: [],
      later: [],
    };
    const text = renderCapabilityText(bills, { capId: "bills", files: new Map([...world, ["bills", bills]]), personName: () => undefined, viewerId: null });
    expect(text.find((s) => s.heading === "Who can see and do what")?.lines).toEqual(["Everyone sees the bills of their team’s contracts."]);
  });
});


describe("a tree (M28)", () => {
  const file: CapabilityFile = {
    name: "Spend",
    icon: "wallet",
    sheets: [
      {
        id: "centres",
        name: "Cost centres",
        kind: "tree",
        tree: { parent: "under" },
        titleColumn: "name",
        row: { one: "cost centre", many: "cost centres" },
        columns: [
          { id: "name", name: "Cost centre", type: "text", required: true },
          { id: "under", name: "Under", type: "link", link: { sheet: "centres" } },
          { id: "spent", name: "Spent", type: "computed", result: "money", expr: { sumOf: { sheet: "expenses", column: "amount", by: "centre" } } },
          { id: "total", name: "Total spent", type: "computed", result: "money", expr: { op: "add", args: [{ col: "spent" }, { sumOf: { sheet: "centres", column: "total", by: "under" } }] } },
        ],
      },
      { id: "expenses", name: "Expenses", kind: "list", titleColumn: "what", columns: [{ id: "what", name: "What for", type: "text" }, { id: "amount", name: "Amount", type: "money" }, { id: "centre", name: "Cost centre", type: "link", link: { sheet: "centres" } }] },
    ],
    roles: [],
    rules: [],
    later: [],
  };

  it("says the rows sit under each other, how deep, what can't be deleted and which total includes the rows under it", () => {
    const [centres] = renderCapabilityText(file, { capId: "spend", files: new Map([["spend", file]]), personName: () => undefined, viewerId: null });
    expect([centres!.heading, ...centres!.lines]).toEqual([
      "Cost centres sheet",
      "Cost centre (text, required), Under (the cost centre it sits under).",
      "Cost centres sit under each other, up to 8 levels deep; one with cost centres under it can't be deleted.",
      "Total spent includes the cost centres under it.",
    ]);
  });
});
