import { beforeAll, describe, expect, it } from "vitest";
import { kernelWorkspace } from "@/tests/kernel";
import { getFile, saveVersion } from "./capabilities";
import { createRow, deleteRows, getRow, moveStep, updateRow } from "./rows";
import type { CapabilityFile } from "./schema/file";
import { validateFile } from "./schema/validate";

// A sum across capabilities, limited to steps: a budget's Spent is the Amount of the Paid bills that link to
// it (Supplier bills and Tools and budgets, 5j). It follows every bill write in the same transaction.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let budgetsCap: string;
let billsCap: string;

// Ada manages both; admins get rows only through a role.
const managers = (ada: string): CapabilityFile["roles"] => [
  { id: "managers", name: "Managers", members: { kind: "people", people: [ada] }, can: ["see", "add", "edit", "delete", "move_steps"], scope: "all" },
];

const budgets = (spent: boolean, billsId = "", ada = k.id.ada): CapabilityFile => ({
  name: "Budgets",
  icon: "wrench",
  sheets: [
    {
      id: "budgets",
      name: "Budgets",
      kind: "list",
      titleColumn: "team",
      columns: [
        { id: "team", name: "Team", type: "text", required: true },
        { id: "budget", name: "Budget", type: "money" },
        ...(spent
          ? [{ id: "spent", name: "Spent", type: "computed" as const, result: "money" as const, expr: { sumOf: { capability: billsId, sheet: "bills", column: "amount", by: "budget", steps: ["paid"] } } }]
          : []),
      ],
    },
  ],
  roles: managers(ada),
  rules: [],
  later: [],
});

const bills = (budgetsId: string, ada = k.id.ada): CapabilityFile => ({
  name: "Bills",
  icon: "receipt",
  sheets: [
    {
      id: "bills",
      name: "Bills",
      kind: "list",
      titleColumn: "supplier",
      columns: [
        { id: "supplier", name: "Supplier", type: "text", required: true },
        { id: "amount", name: "Amount", type: "money", required: true },
        { id: "budget", name: "Budget", type: "link", link: { capability: budgetsId, sheet: "budgets" } },
        { id: "status", name: "Status", type: "step" },
      ],
      steps: [{ id: "received", name: "Received", start: true }, { id: "approved", name: "Approved" }, { id: "paid", name: "Paid", end: "final" }],
    },
  ],
  roles: managers(ada),
  rules: [],
  later: [],
});

beforeAll(async () => {
  k = await kernelWorkspace();
  budgetsCap = await k.create(budgets(false));
  billsCap = await k.create(bills(budgetsCap));
  // Spent comes in a later version, as an Also change does.
  await k.as("ada", (tx, c) => saveVersion(tx, c, budgetsCap, budgets(true, billsCap), { source: "plan", event: "changeset.applied" }));
});

const spentOf = (id: string) => k.as("ada", (tx, c) => getRow(tx, c, id)).then((r) => r.data.spent);
const bill = (supplier: string, amount: number, budget: string) =>
  k.as("ada", (tx, c) => createRow(tx, c, billsCap, "bills", { values: { supplier, amount, budget } })).then((r) => r.id);
const pay = async (id: string) => {
  await k.as("ada", (tx, c) => moveStep(tx, c, id, "approved"));
  await k.as("ada", (tx, c) => moveStep(tx, c, id, "paid"));
};

describe("a sum limited to steps, across capabilities", () => {
  it("adds up only the Paid bills that link to the budget", async () => {
    const eng = await k.as("ada", (tx, c) => createRow(tx, c, budgetsCap, "budgets", { values: { team: "Engineering", budget: 1_000_000 } })).then((r) => r.id);
    expect(await spentOf(eng)).toBe(0);
    const a = await bill("Acme", 20_000, eng);
    const b = await bill("Birch", 5_000, eng);
    expect(await spentOf(eng)).toBe(0); // Received, not Paid
    await pay(a);
    expect(await spentOf(eng)).toBe(20_000);
    await pay(b);
    expect(await spentOf(eng)).toBe(25_000);
  });

  it("follows an edit, a move to another budget, and a delete", async () => {
    const ops = await k.as("ada", (tx, c) => createRow(tx, c, budgetsCap, "budgets", { values: { team: "Operations" } })).then((r) => r.id);
    const sales = await k.as("ada", (tx, c) => createRow(tx, c, budgetsCap, "budgets", { values: { team: "Sales" } })).then((r) => r.id);
    const c1 = await bill("Cedar", 10_000, ops);
    await pay(c1);
    expect(await spentOf(ops)).toBe(10_000);
    await k.as("ada", (tx, c) => updateRow(tx, c, c1, { amount: 12_500 }));
    expect(await spentOf(ops)).toBe(12_500);
    // Moved to another budget: both are worked out again.
    await k.as("ada", (tx, c) => updateRow(tx, c, c1, { budget: sales }));
    expect(await spentOf(ops)).toBe(0);
    expect(await spentOf(sales)).toBe(12_500);
    await k.as("ada", (tx, c) => deleteRows(tx, c, [c1]));
    expect(await spentOf(sales)).toBe(0);
  });

  it("gives the same totals when the same writes run again", async () => {
    const run = async (team: string) => {
      const b = await k.as("ada", (tx, c) => createRow(tx, c, budgetsCap, "budgets", { values: { team } })).then((r) => r.id);
      for (const [s, n] of [["X", 300], ["Y", 700], ["Z", 1_100]] as const) {
        const id = await bill(s, n, b);
        if (s !== "Y") await pay(id);
      }
      return spentOf(b);
    };
    expect(await run("One")).toBe(1_400);
    expect(await run("Two")).toBe(1_400);
  });

  it("refuses a step the summed sheet doesn't have, and a link that doesn't point here", async () => {
    const billsFile = (await k.as("ada", (tx) => getFile(tx, billsCap)))!.file;
    const others = new Map([[billsCap, billsFile]]);
    const wrong = (sum: object) => {
      const f = budgets(true, billsCap);
      f.sheets[0]!.columns[2] = { id: "spent", name: "Spent", type: "computed", result: "money", expr: { sumOf: { capability: billsCap, sheet: "bills", column: "amount", ...sum } } };
      return validateFile(f, { selfId: budgetsCap, others });
    };
    expect(wrong({ by: "budget", steps: ["paid"] }).ok).toBe(true);
    expect(wrong({ by: "budget", steps: ["settled"] })).toEqual({ ok: false, errors: ["Budgets sheet › Spent: Bills has no step “settled” to add up at."] });
    expect(wrong({ by: "supplier", steps: ["paid"] })).toEqual({ ok: false, errors: ["Budgets sheet › Spent: Bills has no link to Budgets called “supplier”."] });
  });
});

// G3: a column is worked out no earlier than the columns it reads, so one built on a column that reads other rows
// or today is worked out when read, after it, never stored empty.
describe("when each computed column is worked out", () => {
  it("follows what it reads", async () => {
    const { workedOut } = await import("./compute");
    const sheet = {
      id: "cards",
      name: "Cards",
      kind: "list",
      titleColumn: "name",
      columns: [
        { id: "name", name: "Name", type: "text" },
        { id: "fee", name: "Fee", type: "money" },
        { id: "double", name: "Double", type: "computed", result: "money", expr: { op: "mul", args: [{ col: "fee" }, 2] } },
        { id: "left", name: "Days left", type: "computed", result: "days", expr: { op: "days_until", args: ["2027-01-10"] } },
        { id: "half_left", name: "Half", type: "computed", result: "days", expr: { op: "div", args: [{ col: "left" }, 2] } },
        { id: "owner", name: "Owner's", type: "computed", result: "text", expr: { col: "name", via: "parent" } },
        { id: "both", name: "Both", type: "computed", result: "text", expr: { op: "if", args: [{ op: "gt", args: [{ col: "half_left" }, 0] }, { col: "owner" }, "none"] } },
      ],
    } as unknown as Parameters<typeof workedOut>[0];
    expect(Object.fromEntries(workedOut(sheet))).toEqual({ double: "stored", left: "today", half_left: "today", owner: "other", both: "other" });
  });
});
