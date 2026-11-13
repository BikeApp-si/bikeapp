import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { PlannerOutput } from "@/server/ai/prompts/workspace-planner@2";
import { PACK_PLAN } from "./fixtures";
import { readForBuild } from "@/server/files/documents";
import { buildPlanParts, checkBuildPlan, findPeopleTable, knownPeople, matchPeople, readLabel, type ReadTable, type ReadText } from "./build";

// The synthetic pack (tests/files/pack) as 4a reads it, and a plan for it as prompt 1 might write it,
// checked by the kernel and shown as 4b.

const texts: ReadText[] = [];
const tables: ReadTable[] = [];
const labels: string[] = [];

beforeAll(async () => {
  for (const name of ["How Fernwood runs.docx", "Fernwood policies.pdf", "zoho-export.zip"]) {
    const r = await readForBuild(name, new Uint8Array(readFileSync(`tests/files/pack/${name}`)));
    const t = r.docs.flatMap((d) => (d.kind === "text" ? [{ name: d.name, pages: d.pages, text: d.text }] : []));
    const s = r.docs.flatMap((d) => (d.kind === "table" ? [{ file: d.name, from: d.from, table: d.table }] : []));
    texts.push(...t);
    tables.push(...s);
    labels.push(readLabel({ name, texts: t, tables: s }));
  }
});

describe("reading the pack (4a)", () => {
  it("names each part as 4a does", () => {
    expect(labels).toEqual(["Read how Fernwood runs, 4 pages", "Read the policies, 38 pages", "Read the Zoho export: 6 files, 3,214 rows"]);
  });

  it("finds People in the export and matches people across the other tables", () => {
    const found = findPeopleTable(tables, "wade@fernwood.dev");
    expect(found?.file).toBe("employees.csv");
    const known = knownPeople(tables, found, [{ name: "Wade Wilson", email: "wade@fernwood.dev" }]);
    expect(known).toHaveLength(14);
    const matches = matchPeople(tables, found!.file, known, "wade@fernwood.dev");
    const by = (file: string, column: string) => matches.find((m) => m.file === file && m.column === column);
    expect(by("expenses.csv", "Employee Email")?.notInPeople).toEqual([]);
    expect(by("contracts.csv", "Account Owner")?.matched).toBe(12);
    // Candidates are outside the company: their emails aren't people.
    expect(matches.some((m) => m.file === "candidates.csv")).toBe(false);
  });

  it("finds no People table when nothing lists the company's people", () => {
    expect(findPeopleTable(tables.filter((t) => t.file !== "employees.csv"), "wade@fernwood.dev")).toBeNull();
  });
});

describe("checking prompt 1's plan", () => {
  const facts = () => ({ texts, tables, existing: [] as string[] });

  it("accepts a plan that names only what was read", () => {
    expect(checkBuildPlan(PACK_PLAN, facts())).toEqual([]);
  });

  it("refuses tables, pages, names and numbers that aren't there", () => {
    const bad: PlannerOutput = {
      ...PACK_PLAN,
      lead: "I read 40 pages.",
      people: { ...PACK_PLAN.people, file: "staff.csv" },
      capabilities: [
        { ...PACK_PLAN.capabilities[0]!, data: ["candidates.csv", "nope.csv"], pages: [{ file: "Fernwood policies.pdf", pages: [39] }] },
        { ...PACK_PLAN.capabilities[3]!, name: "People", data: ["candidates.csv"] },
      ],
      connections: [{ from: "Hiring", to: "Payroll", says: "Hired starts payroll" }],
      holidays: [{ date: "2026-12-25", name: "Christmas", file: "handbook.pdf", page: 1 }],
    };
    const problems = checkBuildPlan(bad, { ...facts(), existing: ["Hiring"] }).join("\n");
    expect(problems).toContain('"staff.csv" isn\'t one of the tables');
    expect(problems).toContain('"nope.csv", which isn\'t one of the tables');
    expect(problems).toContain("38 pages; \"Hiring\" names page 39");
    expect(problems).toContain('"Hiring" already exists');
    expect(problems).toContain("People isn't an app");
    expect(problems).toContain('"candidates.csv" goes to both Hiring and People');
    expect(problems).toContain('names "Payroll"');
    expect(problems).toContain('"handbook.pdf", which isn\'t one of the documents');
    expect(problems).toContain("The lead says 40");
  });
});

describe("the plan reply (4b)", () => {
  it("lists People, then the apps with the rows each brings in, then Build all", () => {
    const parts = buildPlanParts(PACK_PLAN, tables);
    expect(parts[0]).toEqual({ kind: "text", text: PACK_PLAN.lead });
    const table = parts[1] as Extract<(typeof parts)[number], { kind: "table" }>;
    expect(table.columns).toEqual(["#", "App", "What it runs", "Data it brings in"]);
    expect(table.rows[0]).toEqual(["1", "People", "14 people, 5 teams, who reports to whom", "employees.csv · 14 rows"]);
    expect(table.rows[2]).toEqual(["3", "Onboarding", "A first-week plan when someone is hired", "—"]);
    expect(table.rows[4]).toEqual(["5", "Spend", "Expenses and purchases", "expenses.csv · 2,890 rows"]);
    expect(parts[2]).toEqual({
      kind: "text",
      text: "I'll connect them where your policies hand work on: Hired starts a plan in Onboarding, a new starter gets seats in Tools and budgets, and a renewal starts a request in Spend. Your policies also describe 3 approval and reminder rules. I'll write each one as a rule you can read in Customize, with what it would have done on your last 90 days of data.",
    });
    expect(parts[3]).toEqual({ kind: "text", text: "Nothing goes live until you say so." });
    expect(parts[4]).toEqual({ kind: "buttons", buttons: [{ action: "build", label: "Build all", primary: true }] });
  });
});
