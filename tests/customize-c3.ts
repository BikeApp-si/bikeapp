import type { KernelCtx } from "@/server/kernel/context";
import type { CapabilityFile } from "@/server/kernel/schema/file";
import type { Tx } from "@/server/kernel/tx";

// C3's Customize questions (advice), recorded by scripts/ai-record.ts in this order, each capability in its own chat,
// on a Fernwood with Sales leads and Income and expenses (as on Wade's screenshot of Nov 3, with six entries: two
// without a category, none with a receipt). Replayed by server/chat/customize-c3.test.ts; the first by
// tests/e2e/customize.spec.ts.

export const C3 = {
  income: "what other sheets can be added here to improve this capability?",
  sales: "How can this be better?",
  hiring: "What do other companies track for hiring?",
  onboarding: "What am I missing?",
} as const;

const CATEGORIES = ["Sales", "Services", "Other income", "Salaries", "Software", "Travel", "Office", "Marketing", "Taxes", "Other"];
const options = (xs: string[]) => xs.map((n) => ({ id: n.toLowerCase().replace(/[^a-z0-9]+/g, "_"), name: n }));

export function incomeExpensesFile(finance: string[]): CapabilityFile {
  return {
    name: "Income and expenses",
    icon: "wallet",
    sheets: [
      {
        id: "entries",
        name: "Entries",
        kind: "list",
        row: { one: "entry", many: "entries" },
        titleColumn: "description",
        columns: [
          { id: "description", name: "Description", type: "text", required: true },
          { id: "type", name: "Type", type: "choice", options: options(["Income", "Expense"]), required: true },
          { id: "category", name: "Category", type: "choice", options: options(CATEGORIES) },
          { id: "amount", name: "Amount", type: "money", required: true },
          { id: "date", name: "Date", type: "date", required: true, default: { kind: "today" } },
          { id: "paid_to", name: "Paid to or received from", type: "text" },
          { id: "recorded_by", name: "Recorded by", type: "person", default: { kind: "creator" } },
          { id: "receipt", name: "Receipt", type: "file" },
          { id: "notes", name: "Notes", type: "long_text" },
        ],
      },
    ],
    roles: [
      { id: "owner", name: "Finance", members: { kind: "people", people: finance }, can: ["see", "add", "edit", "customize"], scope: "all" },
      { id: "recorders", name: "Recorders", members: { kind: "column", sheet: "entries", column: "recorded_by" }, can: ["see", "add", "edit"], scope: "own", scopeColumns: { entries: { column: "recorded_by" } } },
    ],
    rules: [],
    later: [],
  };
}

// Income and expenses with its six entries, as the person in ctx (an admin).
export async function addIncomeExpenses(tx: Tx, ctx: KernelCtx): Promise<string> {
  const { createCapability } = await import("@/server/kernel/capabilities");
  const { createRow } = await import("@/server/kernel/rows");
  const { id } = await createCapability(tx, ctx, incomeExpensesFile([ctx.actor.id]), { source: "build" });
  const entries: [string, string, string | null, number, string, string][] = [
    ["Client retainer, Northwind", "income", "services", 1200000, "2026-10-01", "Northwind"],
    ["Figma, team plan", "expense", "software", 7500, "2026-10-03", "Figma"],
    ["Flights to Austin", "expense", "travel", 64000, "2026-10-08", "United"],
    ["Office snacks", "expense", null, 4200, "2026-10-10", "Costco"],
    ["test", "expense", null, 100, "2026-10-12", ""],
    ["Payroll, October", "expense", "salaries", 3800000, "2026-10-31", "Gusto"],
  ];
  for (const [description, type, category, amount, date, paid_to] of entries)
    await createRow(tx, ctx, id, "entries", { values: { description, type, ...(category ? { category } : {}), amount, date, paid_to } });
  return id;
}
