import { beforeAll, describe, expect, it } from "vitest";
import { kernelWorkspace, type Name } from "@/tests/kernel";
import type { CapabilityFile } from "./schema/file";
import { saveVersion } from "./capabilities";
import { countRows, createRow, deleteRows, getRow, listRows, moveStep, updateRow } from "./rows";

let k: Awaited<ReturnType<typeof kernelWorkspace>>;

// Expenses: everyone adds and works on their own; leads see their team's and move them out of Submitted
// only; Ada (finance) sees and does everything.
function expensesFile(finance: string): CapabilityFile {
  return {
    name: "Spend",
    icon: "wallet",
    sheets: [
      {
        id: "expenses",
        name: "Expenses",
        kind: "list",
        titleColumn: "what",
        columns: [
          { id: "what", name: "What for", type: "text", required: true },
          { id: "who", name: "Who", type: "person", default: { kind: "creator" } },
          { id: "amount", name: "Amount", type: "money" },
          { id: "status", name: "Status", type: "step" },
        ],
        steps: [
          { id: "submitted", name: "Submitted", start: true },
          { id: "approved", name: "Approved" },
          { id: "paid", name: "Paid", end: "final" },
          { id: "rejected", name: "Rejected", end: "exit" },
        ],
      },
    ],
    roles: [
      { id: "finance", name: "Finance", members: { kind: "people", people: [finance] }, can: ["see", "add", "edit", "delete", "move_steps"], scope: "all" },
      { id: "everyone", name: "Everyone", members: { kind: "everyone" }, can: ["see", "add", "edit", "delete"], scope: "own", scopeColumns: { expenses: { column: "who" } } },
      { id: "leads", name: "Team leads", members: { kind: "everyone" }, can: ["see", "move_steps"], moveFrom: ["submitted"], scope: "team", scopeColumns: { expenses: { column: "who" } } },
    ],
    rules: [],
    later: [],
  };
}

// Openings with a hiring manager; candidates belong to an opening. Managers see their openings' candidates.
function hiringFile(recruiter: string): CapabilityFile {
  return {
    name: "Hiring",
    icon: "briefcase-business",
    sheets: [
      {
        id: "openings",
        name: "Openings",
        kind: "list",
        titleColumn: "role",
        columns: [
          { id: "role", name: "Role", type: "text", required: true },
          { id: "manager", name: "Hiring manager", type: "person" },
        ],
      },
      {
        id: "candidates",
        name: "Candidates",
        kind: "list",
        titleColumn: "name",
        columns: [
          { id: "name", name: "Name", type: "text", required: true },
          { id: "opening", name: "Opening", type: "link", link: { sheet: "openings" } },
        ],
      },
    ],
    roles: [
      { id: "recruiters", name: "Recruiters", members: { kind: "people", people: [recruiter] }, can: ["see", "add", "edit", "delete"], scope: "all" },
      {
        id: "managers",
        name: "Hiring managers",
        members: { kind: "column", sheet: "openings", column: "manager" },
        can: ["see", "edit"],
        scope: "own",
        scopeColumns: { openings: { column: "manager" }, candidates: { via: "opening", column: "manager" } },
      },
    ],
    rules: [],
    later: [],
  };
}

let spend: string;
let hiring: string;
const expense: Record<string, string> = {};

const TITLE: Record<string, string> = { expenses: "what", openings: "role", candidates: "name" };
const titles = (n: Name, cap: string, sheet: string) =>
  k.as(n, (tx, c) => listRows(tx, c, cap, sheet)).then((rs) => rs.map((r) => String(r.data[TITLE[sheet]!])).sort());

beforeAll(async () => {
  k = await kernelWorkspace();
  spend = await k.create(expensesFile(k.id.ada));
  for (const n of ["maya", "omar", "rita", "priya"] as Name[]) {
    expense[n] = (await k.as(n, (tx, c) => createRow(tx, c, spend, "expenses", { values: { what: `${n} lunch`, amount: 4_000 } }))).id;
  }
  hiring = await k.create(hiringFile(k.id.ada));
});

describe("scope all", () => {
  it("sees, edits, moves and deletes every row", async () => {
    expect(await titles("ada", spend, "expenses")).toEqual(["maya lunch", "omar lunch", "priya lunch", "rita lunch"]);
    await k.as("ada", (tx, c) => updateRow(tx, c, expense.rita!, { amount: 4_500 }));
    await k.as("ada", (tx, c) => moveStep(tx, c, expense.rita!, "approved"));
  });
});

describe("scope own", () => {
  it("sees only their own rows", async () => {
    expect(await titles("rita", spend, "expenses")).toEqual(["rita lunch"]);
    expect(await k.as("rita", (tx, c) => countRows(tx, c, spend, "expenses"))).toBe(1);
  });

  it("edits and deletes their own, and is told nothing about anyone else's", async () => {
    await k.as("omar", (tx, c) => updateRow(tx, c, expense.omar!, { amount: 4_200 }));
    for (const fn of [
      () => k.as("omar", (tx, c) => getRow(tx, c, expense.rita!)),
      () => k.as("omar", (tx, c) => updateRow(tx, c, expense.rita!, { amount: 1 })),
      () => k.as("omar", (tx, c) => deleteRows(tx, c, [expense.rita!])),
    ])
      await expect(fn()).rejects.toThrow("That row doesn't exist, or you can't see it.");
    const extra = await k.as("omar", (tx, c) => createRow(tx, c, spend, "expenses", { values: { what: "omar taxi" } }));
    await k.as("omar", (tx, c) => deleteRows(tx, c, [extra.id]));
  });

  it("can't add a row that isn't theirs, or hand their row to someone else", async () => {
    await expect(k.as("maya", (tx, c) => createRow(tx, c, spend, "expenses", { values: { what: "for Omar", who: k.id.omar } }))).rejects.toThrow("You can't do that here.");
    await expect(k.as("maya", (tx, c) => updateRow(tx, c, expense.maya!, { who: k.id.omar }))).rejects.toThrow("You can't do that here.");
  });
});

describe("scope team: the manager chain from People", () => {
  it("Priya sees hers, Maya's and Omar's, not Rita's", async () => {
    expect(await titles("priya", spend, "expenses")).toEqual(["maya lunch", "omar lunch", "priya lunch"]);
  });

  it("moves her team's rows only from the steps her role lists", async () => {
    await k.as("priya", (tx, c) => moveStep(tx, c, expense.maya!, "approved"));
    await expect(k.as("priya", (tx, c) => moveStep(tx, c, expense.maya!, "paid"))).rejects.toThrow("You can't do that here.");
    await expect(k.as("priya", (tx, c) => moveStep(tx, c, expense.rita!, "approved"))).rejects.toThrow("doesn't exist");
  });

  it("sees but can't edit or delete them (her team role can only see and move)", async () => {
    await expect(k.as("priya", (tx, c) => updateRow(tx, c, expense.omar!, { amount: 1 }))).rejects.toThrow("You can't do that here.");
    await expect(k.as("priya", (tx, c) => deleteRows(tx, c, [expense.omar!]))).rejects.toThrow("You can't do that here.");
  });

  it("follows People: a new manager sees the rows at once", async () => {
    await k.as("ada", (tx) => tx.execute(`update people set manager_id = '${k.id.priya}' where id = '${k.id.rita}'`));
    expect(await titles("priya", spend, "expenses")).toContain("rita lunch");
    await k.as("ada", (tx) => tx.execute(`update people set manager_id = '${k.id.ada}' where id = '${k.id.rita}'`));
    expect(await titles("priya", spend, "expenses")).not.toContain("rita lunch");
  });
});

describe("scope one hop through a link", () => {
  let backend: string;
  let frontend: string;
  beforeAll(async () => {
    const opening = (role: string, manager: string) => k.as("ada", (tx, c) => createRow(tx, c, hiring, "openings", { values: { role, manager } })).then((r) => r.id);
    backend = await opening("Senior backend", k.id.priya);
    frontend = await opening("Frontend", k.id.rita);
    const candidate = (name: string, op: string) => k.as("ada", (tx, c) => createRow(tx, c, hiring, "candidates", { values: { name, opening: op } }));
    for (const n of ["Sam Okafor", "Tom Weiss", "Jordan Lee"]) await candidate(n, backend);
    for (const n of ["Grace Kim", "Eli Brooks"]) await candidate(n, frontend);
  });

  it("Priya sees exactly the candidates for her openings", async () => {
    expect(await titles("priya", hiring, "openings")).toEqual(["Senior backend"]);
    expect(await titles("priya", hiring, "candidates")).toEqual(["Jordan Lee", "Sam Okafor", "Tom Weiss"]);
    expect(await titles("rita", hiring, "candidates")).toEqual(["Eli Brooks", "Grace Kim"]);
  });

  it("changing an opening's hiring manager changes who sees its candidates at once, with no write to them", async () => {
    const before = await k.as("ada", (tx, c) => listRows(tx, c, hiring, "candidates"));
    await k.as("ada", (tx, c) => updateRow(tx, c, frontend, { manager: k.id.priya }));
    expect(await titles("priya", hiring, "candidates")).toEqual(["Eli Brooks", "Grace Kim", "Jordan Lee", "Sam Okafor", "Tom Weiss"]);
    expect(await titles("rita", hiring, "candidates")).toEqual([]);
    const after = await k.as("ada", (tx, c) => listRows(tx, c, hiring, "candidates"));
    expect(after.map((r) => r.updatedAt)).toEqual(before.map((r) => r.updatedAt));
    await k.as("ada", (tx, c) => updateRow(tx, c, frontend, { manager: k.id.rita }));
  });

  it("a scope two hops away is refused when the file is saved", async () => {
    const file = hiringFile(k.id.ada);
    file.sheets.push({
      id: "interviews",
      name: "Interviews",
      kind: "list",
      titleColumn: "candidate",
      columns: [{ id: "candidate", name: "Candidate", type: "link", link: { sheet: "candidates" } }],
    });
    file.roles[1]!.scopeColumns!.interviews = { via: "candidate", column: "manager" };
    await expect(k.as("ada", (tx, c) => saveVersion(tx, c, hiring, file, { source: "customize", event: "customize.saved" }))).rejects.toMatchObject({
      problems: [expect.stringMatching(/at most one link away/)],
    });
  });
});

describe("no role", () => {
  it("sees nothing and is refused, even with a real row id", async () => {
    const outsider = await k.create({ ...expensesFile(k.id.ada), roles: [expensesFile(k.id.ada).roles[0]!] });
    const row = await k.as("ada", (tx, c) => createRow(tx, c, outsider, "expenses", { values: { what: "Private", who: k.id.ada } }));
    expect(await k.as("maya", (tx, c) => listRows(tx, c, outsider, "expenses"))).toEqual([]);
    expect(await k.as("maya", (tx, c) => countRows(tx, c, outsider, "expenses"))).toBe(0);
    await expect(k.as("maya", (tx, c) => getRow(tx, c, row.id))).rejects.toThrow("That row doesn't exist, or you can't see it.");
    await expect(k.as("maya", (tx, c) => updateRow(tx, c, row.id, { what: "Mine" }))).rejects.toThrow("doesn't exist");
    await expect(k.as("maya", (tx, c) => createRow(tx, c, outsider, "expenses", { values: { what: "x" } }))).rejects.toThrow("You can't do that here.");
  });

  it("being an admin gives no rows by itself", async () => {
    const notAda = await k.create({ ...expensesFile(k.id.priya), roles: [expensesFile(k.id.priya).roles[0]!] });
    await k.as("priya", (tx, c) => createRow(tx, c, notAda, "expenses", { values: { what: "Priya's", who: k.id.priya } }));
    expect(await k.as("ada", (tx, c) => listRows(tx, c, notAda, "expenses"))).toEqual([]);
  });
});
