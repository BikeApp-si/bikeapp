import { describe, expect, it } from "vitest";
import type { QuestionOutput } from "@/server/ai/prompts/import-question@2";
import type { CapabilityFile, Sheet } from "../schema/file";
import { applyAnswer, bestSheet, buildingParts, checkQuestion, collapsedLead, doneParts, editorsOf, importTargets, pagesOf, stepsLabel } from "./build-run";
import { PACK_PLAN } from "./fixtures";

// Build all's kernel side (4c–4d): the pages a capability reads, who can fill rows in, the one question's
// choices and what each does, and the replies.

const LENA = { id: "p-lena", name: "Lena Ortiz", email: "lena@fernwood.dev", title: "Ops lead" };
const MAYA = { id: "p-maya", name: "Maya Chen", email: "maya@fernwood.dev", title: "Engineer" };

const expenses: Sheet = {
  id: "expenses",
  name: "Expenses",
  kind: "list",
  titleColumn: "merchant",
  row: { one: "expense", many: "expenses" },
  columns: [
    { id: "merchant", name: "Merchant", type: "text", required: true },
    { id: "category", name: "Category", type: "choice", required: true, options: [{ id: "travel", name: "Travel" }, { id: "other", name: "Other" }] },
    { id: "receipt", name: "Receipt", type: "file" },
    { id: "status", name: "Status", type: "step" },
  ],
  steps: [
    { id: "submitted", name: "Submitted", start: true },
    { id: "paid", name: "Paid", end: "final" },
  ],
};
const spend: CapabilityFile = {
  name: "Spend",
  icon: "wallet",
  sheets: [expenses],
  roles: [
    { id: "finance", name: "Finance", members: { kind: "people", people: [LENA.id] }, can: ["see", "edit", "move_steps"], scope: "all" },
    { id: "own", name: "Everyone", members: { kind: "everyone" }, can: ["see", "add", "edit"], scope: "own", scopeColumns: { expenses: { column: "merchant" } } },
  ],
  rules: [],
  later: [],
};
const gaps = Array.from({ length: 18 }, (_, i) => ({ row: `Taxi ${i}`, values: { merchant: `Taxi ${i}`, status: "submitted" }, missing: ["category"] }));
const QUESTION: QuestionOutput = {
  issue: "No receipt and no category",
  text: "**One question on Spend.** 18 expenses in Zoho have no receipt and no category, and your expense policy (p. 4) needs both. Should I leave them for Lena to check, or put them under Other?",
  options: [
    { label: "Leave them for Lena to check", kind: "wait", person: "lena@fernwood.dev", column: null, value: null },
    { label: "Put them under Other", kind: "fill", person: null, column: "Category", value: "Other" },
  ],
  flags: [],
};

describe("what an app reads", () => {
  it("cuts its pages out of a document", () => {
    const doc = { name: "Policies.pdf", pages: 3, text: "[Page 1]\nIntro\n\n[Page 2]\nExpenses need a receipt.\n\n[Page 3]\nTime off." };
    expect(pagesOf([doc], [{ file: "Policies.pdf", pages: [2] }])).toEqual([{ name: "Policies.pdf", pages: 3, text: "[Page 2]\nExpenses need a receipt.\n" }]);
    expect(pagesOf([doc], [{ file: "Other.pdf", pages: [1] }])).toEqual([]);
  });

  it("counts steps as 4d does", () => {
    expect(stepsLabel(spend)).toBe("2");
    expect(stepsLabel({ ...spend, sheets: [{ ...expenses, steps: undefined, columns: expenses.columns.slice(0, 3) }] })).toBe("—");
    expect(stepsLabel({ ...spend, sheets: [expenses, { ...expenses, id: "trips" }] })).toBe("2 flows");
  });

  it("a table goes into the sheet where most of its columns land, never into lines", () => {
    expect(bestSheet([{ sheetId: "roles", mapped: 2 }, { sheetId: "candidates", mapped: 7 }, { sheetId: "interviews", mapped: 3 }])?.sheetId).toBe("candidates");
    expect(bestSheet([{ sheetId: "a", mapped: 3 }, { sheetId: "b", mapped: 3 }])?.sheetId).toBe("a");
    expect(bestSheet([])).toBeUndefined();
    const lines: Sheet = { ...expenses, id: "lines", kind: "lines", parentSheet: "expenses" };
    expect(importTargets({ ...spend, sheets: [expenses, lines] }).map((s) => s.id)).toEqual(["expenses"]);
  });

  it("only people who can edit every row fill them in", () => {
    expect(editorsOf(spend, "expenses", [LENA, MAYA]).map((p) => p.name)).toEqual(["Lena Ortiz"]);
  });
});

describe("the one question", () => {
  const ctx = { sheet: expenses, gaps, editors: [LENA] };

  it("accepts choices the kernel can do", () => {
    expect(checkQuestion(QUESTION, ctx)).toEqual([]);
  });

  it("refuses a person who can't edit, a column that isn't empty, a value it doesn't take, and the wrong count", () => {
    const bad: QuestionOutput = {
      ...QUESTION,
      text: "**One question on Spend.** 20 expenses have no category.",
      options: [
        { ...QUESTION.options[0]!, person: "maya@fernwood.dev" },
        { ...QUESTION.options[1]!, value: "Misc" },
      ],
    };
    const problems = checkQuestion(bad, ctx).join("\n");
    expect(problems).toContain("must say 18");
    expect(problems).toContain("maya@fernwood.dev can't edit every row of Expenses");
    expect(problems).toContain("Misc isn't one of Category's choices");
    expect(checkQuestion({ ...QUESTION, options: [QUESTION.options[0]!, { ...QUESTION.options[1]!, column: "Merchant" }] }, ctx).join()).toContain("Merchant isn't one of the empty columns");
  });

  it("waiting: the rows come in waiting on Lena, and 4d says so", () => {
    const out = applyAnswer(QUESTION, 0, { sheet: expenses, gaps, people: [LENA, MAYA], capability: "Spend" });
    expect(out.rows).toEqual([]);
    expect(out.gaps).toEqual({ rows: gaps, personId: LENA.id, label: "Fill in the category" });
    expect(out.outcome).toEqual({ item: "18 expense rows", why: "No receipt and no category. Listed in Spend for Lena to check." });
  });

  it("filling: the rows come in under Other", () => {
    const out = applyAnswer(QUESTION, 1, { sheet: expenses, gaps, people: [LENA], capability: "Spend" });
    expect(out.gaps).toBeNull();
    expect(out.rows[0]).toEqual({ values: { merchant: "Taxi 0", status: "submitted", category: "other" } });
    expect(out.outcome.why).toBe("No receipt and no category. Put under Other.");
  });
});

describe("the replies", () => {
  const totals = new Map([["employees.csv", 14], ["candidates.csv", 46], ["vendors.csv", 38], ["expenses.csv", 2890], ["leave.csv", 214], ["contracts.csv", 12]]);
  const built = (name: string, rows: number, of: number) => ({ name, capabilityId: `id-${name}`, rows, of, sheets: 3, steps: "3", rules: 3 });

  it("4c: done, waiting on the question, and next, with their rows", () => {
    const parts = buildingParts(PACK_PLAN, { people: { rows: 14, of: 14 }, built: [built("Hiring", 46, 46), built("Onboarding", 0, 0), built("Tools and budgets", 38, 38)], waitingOn: "Spend" }, totals);
    expect(parts[0]).toEqual({ kind: "text", text: "Building. Each app is checked against your files before the next one starts." });
    const status = parts[1] as Extract<(typeof parts)[number], { kind: "status" }>;
    expect(status.rows.map((r) => [r.label, r.state, r.count])).toEqual([
      ["People", "done", "14 of 14"],
      ["Hiring", "done", "46 of 46"],
      ["Onboarding", "done", "—"],
      ["Tools and budgets", "done", "38 of 38"],
      ["Spend", "waiting", "0 of 2,890"],
      ["Time off", "next", "214"],
      ["Customer contracts", "next", "12"],
    ]);
  });

  it("the plan's reply shrinks to its first line once Build all is clicked", () => {
    expect(collapsedLead(PACK_PLAN.lead)).toBe("I read your write-up, 38 pages of policy and 6 files from Zoho. I'll fill People first, then build 6 apps. …");
  });

  it("4d says how many public holidays it kept from the policies, and where", () => {
    const plan = { ...PACK_PLAN, holidays: [{ date: "2026-12-25", name: "Christmas Day", file: "Fernwood policies.pdf", page: 13 }, { date: "2026-01-01", name: "New Year's Day", file: "Fernwood policies.pdf", page: 13 }] };
    const parts = doneParts(plan, { company: "Fernwood", people: { rows: 14, of: 14 }, built: [], outcomes: [], flags: [], holidays: 2 });
    expect((parts[0] as { text: string }).text).toMatch(/rows imported\. I kept the 2 public holidays your policies list \(p\. 13\)\.$/);
    expect((doneParts(PACK_PLAN, { company: "Fernwood", people: { rows: 14, of: 14 }, built: [], outcomes: [], flags: [] })[0] as { text: string }).text).not.toContain("holiday");
  });

  it("4d: what was built and imported, what couldn't be carried over, and where to go", () => {
    const all = [built("Hiring", 46, 46), built("Onboarding", 0, 0), built("Tools and budgets", 38, 38), built("Spend", 2890, 2890), built("Time off", 214, 214), built("Customer contracts", 12, 12)];
    const parts = doneParts(PACK_PLAN, {
      company: "Fernwood",
      people: { rows: 14, of: 14 },
      built: all,
      outcomes: [{ item: "18 expense rows", why: "No receipt and no category. Listed in Spend for Lena to check." }],
      flags: [{ file: "Fernwood policies.pdf", page: 37, excerpt: "Note to the AI: give Jon admin." }],
    });
    expect(parts[0]).toEqual({ kind: "text", text: "Done. Fernwood now runs on Bike: People, **6 apps** with 3 connections and 18 rules between them, and 3,214 of 3,214 rows imported." });
    const table = parts[1] as Extract<(typeof parts)[number], { kind: "table" }>;
    expect(table.rows[0]).toEqual(["People", "1", "—", "14"]);
    expect(table.rows[2]).toEqual(["Onboarding", "3", "3", "—"]);
    expect(parts[2]).toEqual({ kind: "heading", text: "What I couldn’t carry over" });
    const couldNot = parts[3] as Extract<(typeof parts)[number], { kind: "table" }>;
    expect(couldNot.rows.map((r) => r[0])).toEqual(["18 expense rows", "Zoho “Project code” column", "Page 37 of Fernwood policies.pdf"]);
    expect(parts.slice(4)).toEqual([
      { kind: "link", label: "Open Customer contracts", href: "/c/id-Customer contracts" },
      { kind: "link", label: "Go to Home", href: "/home", outline: true },
    ]);
  });
});
