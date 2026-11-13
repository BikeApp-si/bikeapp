import { beforeAll, describe, expect, it } from "vitest";
import { kernelWorkspace } from "@/tests/kernel";
import type { CapabilityFile } from "./schema/file";
import { createRow, getRow } from "./rows";

// A default that reads a linked row (E1): a candidate's Hiring manager comes from its opening when it is added, before
// its access is checked, so a manager who sees candidates by Hiring manager can add one to their own opening.
let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let hiring: string;
const opening: Record<string, string> = {};

function hiringFile(recruiter: string, required = false): CapabilityFile {
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
          { id: "manager", name: "Hiring manager", type: "person", required, default: { kind: "expr", expr: { col: "manager", via: "opening" } } },
        ],
      },
    ],
    roles: [
      { id: "recruiters", name: "Recruiters", members: { kind: "people", people: [recruiter] }, can: ["see", "add", "edit", "delete"], scope: "all" },
      {
        id: "managers",
        name: "Hiring managers",
        members: { kind: "everyone" },
        can: ["see", "add"],
        scope: "own",
        scopeColumns: { openings: { column: "manager" }, candidates: { column: "manager" } },
      },
    ],
    rules: [],
    later: [],
  };
}

beforeAll(async () => {
  k = await kernelWorkspace();
  hiring = await k.create(hiringFile(k.id.ada));
  for (const [role, who] of [["Designer", "priya"], ["Engineer", "rita"]] as const)
    opening[who] = (await k.as("ada", (tx, c) => createRow(tx, c, hiring, "openings", { values: { role, manager: k.id[who] } }))).id;
});

describe("a default that reads a linked row", () => {
  it("is filled from the linked row when the row is added", async () => {
    const { id } = await k.as("ada", (tx, c) => createRow(tx, c, hiring, "candidates", { values: { name: "Lea", opening: opening.priya } }));
    const row = await k.as("ada", (tx, c) => getRow(tx, c, id));
    expect(row.data.manager).toBe(k.id.priya);
  });

  it("is filled before access is checked, so a manager adds to their own opening (another's they can't even pick)", async () => {
    const { id } = await k.as("priya", (tx, c) => createRow(tx, c, hiring, "candidates", { values: { name: "Ivo", opening: opening.priya } }));
    expect((await k.as("priya", (tx, c) => getRow(tx, c, id))).data.manager).toBe(k.id.priya);
    await expect(k.as("priya", (tx, c) => createRow(tx, c, hiring, "candidates", { values: { name: "Ana", opening: opening.rita } }))).rejects.toThrow("Opening must be a row you can see.");
  });

  it("keeps a value given by hand", async () => {
    const { id } = await k.as("ada", (tx, c) => createRow(tx, c, hiring, "candidates", { values: { name: "Tom", opening: opening.priya, manager: k.id.rita } }));
    expect((await k.as("ada", (tx, c) => getRow(tx, c, id))).data.manager).toBe(k.id.rita);
  });

  it("stays empty with no linked row, and a required one is then refused in plain words", async () => {
    const { id } = await k.as("ada", (tx, c) => createRow(tx, c, hiring, "candidates", { values: { name: "Eva" } }));
    expect((await k.as("ada", (tx, c) => getRow(tx, c, id))).data.manager).toBeUndefined();
    const strict = await k.create(hiringFile(k.id.ada, true));
    const o = (await k.as("ada", (tx, c) => createRow(tx, c, strict, "openings", { values: { role: "Writer", manager: k.id.priya } }))).id;
    await expect(k.as("ada", (tx, c) => createRow(tx, c, strict, "candidates", { values: { name: "Eva" } }))).rejects.toThrow("Hiring manager is required.");
    const { id: ok } = await k.as("ada", (tx, c) => createRow(tx, c, strict, "candidates", { values: { name: "Nik", opening: o } }));
    expect((await k.as("ada", (tx, c) => getRow(tx, c, ok))).data.manager).toBe(k.id.priya);
  });
});
