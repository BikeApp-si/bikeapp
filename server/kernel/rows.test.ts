import { beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { auditEntries, rows } from "@/db/schema";
import { kernelWorkspace } from "@/tests/kernel";
import { saveVersion } from "./capabilities";
import { contractsFile } from "./fixtures";
import type { CapabilityFile } from "./schema/file";
import { bulkUpdate, countRows, createRow, deleteRows, getRow, importRows, listRows, moveStep, movesFor, updateRow } from "./rows";
import type { Tx } from "./tx";

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let contracts: string;
let timeOff: string;
const NOW = new Date("2026-10-27T15:00:00Z");

const lastAudit = (tx: Tx) => tx.select().from(auditEntries).orderBy(desc(auditEntries.seq)).limit(1).then((r) => r[0]!);
const auditCount = (tx: Tx) => tx.$count(auditEntries);

function timeOffFile(): CapabilityFile {
  return {
    name: "Time off",
    icon: "calendar-days",
    sheets: [
      {
        id: "requests",
        name: "Requests",
        kind: "list",
        titleColumn: "who",
        columns: [
          { id: "who", name: "Who", type: "person", default: { kind: "creator" }, required: true },
          { id: "from", name: "From", type: "date", required: true },
          { id: "to", name: "To", type: "date", required: true },
          { id: "days", name: "Days", type: "computed", result: "number", expr: { op: "workdays", args: [{ col: "from" }, { col: "to" }] } },
          { id: "status", name: "Status", type: "step" },
        ],
        steps: [
          { id: "submitted", name: "Submitted", start: true },
          { id: "approved", name: "Approved", moveIn: "not_submitter" },
          { id: "declined", name: "Declined", end: "exit", moveIn: "not_submitter" },
          { id: "taken", name: "Taken", end: "final" },
        ],
      },
    ],
    roles: [{ id: "everyone", name: "Everyone", members: { kind: "everyone" }, can: ["see", "add", "move_steps"], scope: "team", scopeColumns: { requests: { column: "who" } } }],
    rules: [],
    later: [],
  };
}

beforeAll(async () => {
  k = await kernelWorkspace();
  contracts = await k.create(contractsFile([k.id.ada]));
  timeOff = await k.create(timeOffFile());
});

const newContract = (values: Record<string, unknown>, now = NOW) => k.as("ada", (tx, c) => createRow(tx, c, contracts, "contracts", { values }), now);

describe("createRow", () => {
  it("stores values by column id with defaults, the step, the file version, and one audit entry", async () => {
    const { id } = await newContract({ customer: "Kova", value: 1_080_000, start: "2026-03-10" });
    await k.as("ada", async (tx, c) => {
      const [stored] = await tx.select().from(rows).where(eq(rows.id, id));
      expect(stored).toMatchObject({
        sheetId: "contracts",
        stepId: "draft",
        fileVersion: 1,
        createdBy: k.id.ada,
        data: { customer: "Kova", value: 1_080_000, start: "2026-03-10", renews: "2027-03-10", notice: 30, owner: k.id.ada, status: "draft" },
      });
      // Days left uses today, so it is worked out when read, never stored.
      expect((stored!.data as Record<string, unknown>).days_left).toBeUndefined();
      expect((await getRow(tx, { ...c, now: NOW }, id)).data.days_left).toBe(134);
      expect(await lastAudit(tx)).toMatchObject({ who: k.email("ada"), capabilityId: contracts, event: "row.created", details: { sheet: "Contracts", row: "Kova", by: "hand" } });
    });
  });

  it("writes nothing when a check fails", async () => {
    await k.as("ada", async (tx) => {
      const before = { rows: await tx.$count(rows), audit: await auditCount(tx) };
      await expect(createRow(tx, k.ctx("ada"), contracts, "contracts", { values: { customer: "No value" } })).rejects.toThrow("Value a year is required.");
      expect({ rows: await tx.$count(rows), audit: await auditCount(tx) }).toEqual(before);
    });
  });

  it("refuses a person who isn't in People", async () => {
    await expect(newContract({ customer: "Ghost", value: 1, owner: "00000000-0000-4000-8000-0000000000aa" })).rejects.toThrow("Owner must be someone in People.");
  });
});

describe("updateRow", () => {
  it("writes the changes from and to, and the version it was written under", async () => {
    const { id } = await newContract({ customer: "Northwind", value: 3_840_000 });
    await k.as("ada", async (tx, c) => {
      const file = contractsFile([k.id.ada]);
      file.sheets[0]!.columns.find((col) => col.id === "notice")!.name = "Notice period";
      await saveVersion(tx, c, contracts, file, { source: "customize", event: "customize.saved" });
    });
    const r = await k.as("ada", (tx, c) => updateRow(tx, c, id, { value: 4_100_000 }));
    expect(r.changes).toEqual([{ column: "value", name: "Value a year", from: 38_400, to: 41_000 }]); // as the Audit log records it
    await k.as("ada", async (tx) => {
      const [stored] = await tx.select().from(rows).where(eq(rows.id, id));
      expect(stored!.fileVersion).toBe(2);
      expect(await lastAudit(tx)).toMatchObject({ event: "row.updated", details: { sheet: "Contracts", row: "Northwind", changes: r.changes } });
    });
  });

  it("writes nothing when nothing changes", async () => {
    const { id } = await newContract({ customer: "Same", value: 100 });
    await k.as("ada", async (tx, c) => {
      const before = await auditCount(tx);
      expect((await updateRow(tx, c, id, { value: 100 })).changes).toEqual([]);
      expect(await auditCount(tx)).toBe(before);
    });
  });
});

describe("moveStep: along the flow", () => {
  async function at(values: Record<string, unknown>, steps: string[]) {
    const { id } = await newContract(values);
    for (const s of steps) await k.as("ada", (tx, c) => moveStep(tx, c, id, s));
    return id;
  }
  const move = (id: string, to: string) => k.as("ada", (tx, c) => moveStep(tx, c, id, to));
  const moves = (id: string) => k.as("ada", (tx, c) => movesFor(tx, c, id)).then((m) => m.map((s) => s.id));

  it("moves forward one step and writes row.step", async () => {
    const id = await at({ customer: "Pinecone Labs", value: 1_920_000 }, []);
    await move(id, "signed");
    await k.as("ada", async (tx) => {
      expect(await lastAudit(tx)).toMatchObject({ event: "row.step", details: { sheet: "Contracts", row: "Pinecone Labs", from: "Draft", to: "Signed" } });
      expect((await tx.select({ s: rows.stepId }).from(rows).where(eq(rows.id, id)))[0]!.s).toBe("signed");
    });
  });

  it("refuses a skip", async () => {
    const id = await at({ customer: "Skipper", value: 100 }, []);
    await expect(move(id, "active")).rejects.toThrow("Skipper can't move from Draft to Active.");
  });

  it("can't skip Legal review over $50,000, and skips it under", async () => {
    const big = await at({ customer: "Brightline", value: 5_760_000 }, ["signed"]);
    expect(await moves(big)).toEqual(["draft", "legal", "ended"]);
    await expect(move(big, "active")).rejects.toThrow("Brightline can't move from Signed to Active.");
    await move(big, "legal");

    const small = await at({ customer: "Kova", value: 1_080_000 }, ["signed"]);
    expect(await moves(small)).toEqual(["draft", "active", "ended"]);
    await move(small, "active");
    // Back one step skips Legal review too.
    expect(await moves(small)).toEqual(["signed", "ended", "renewed"]);
  });

  it("reaches a final step only by moving forward; an exit from anywhere", async () => {
    const id = await at({ customer: "Orbit Health", value: 1_440_000 }, []);
    await expect(move(id, "renewed")).rejects.toThrow("can't move from Draft to Renewed");
    await move(id, "ended");
  });

  it("Time off: Submitted → Declined, but never Submitted → Taken", async () => {
    const req = (from: string) => k.as("maya", (tx, c) => createRow(tx, c, timeOff, "requests", { values: { from, to: "2026-12-31" } }));
    const a = await req("2026-12-28");
    const b = await req("2026-12-29");
    expect(a.data).toMatchObject({ who: k.id.maya, status: "submitted", days: 4 });
    await expect(k.as("priya", (tx, c) => moveStep(tx, c, a.id, "taken"))).rejects.toThrow("Maya Chen can't move from Submitted to Taken.");
    await k.as("priya", (tx, c) => moveStep(tx, c, a.id, "declined"));
    await k.as("priya", (tx, c) => moveStep(tx, c, b.id, "approved"));
    await k.as("priya", (tx, c) => moveStep(tx, c, b.id, "taken"));
  });
});

describe("nobody approves their own request", () => {
  it("Maya can't approve or decline her own request, whatever her role; Priya can approve it", async () => {
    const { id } = await k.as("maya", (tx, c) => createRow(tx, c, timeOff, "requests", { values: { from: "2026-11-23", to: "2026-11-25" } }));
    // Maya's team scope covers her own rows, so only this rule stops her.
    expect(await k.as("maya", (tx, c) => movesFor(tx, c, id))).toEqual([]);
    await expect(k.as("maya", (tx, c) => moveStep(tx, c, id, "approved"))).rejects.toThrow("Maya Chen is yours, so someone else moves it to Approved.");
    await expect(k.as("maya", (tx, c) => moveStep(tx, c, id, "declined"))).rejects.toThrow("someone else moves it to Declined");
    expect((await k.as("priya", (tx, c) => movesFor(tx, c, id))).map((m) => m.id)).toEqual(["approved", "declined"]);
    await k.as("priya", (tx, c) => moveStep(tx, c, id, "approved"));
  });

  it("holds after the approval step is renamed: it comes from the step's setting, not its name", async () => {
    const renamed = timeOffFile();
    renamed.sheets[0]!.steps!.find((s) => s.id === "approved")!.name = "Signed off";
    await k.as("ada", (tx, c) => saveVersion(tx, c, timeOff, renamed, { source: "customize", event: "customize.saved" }));
    const { id } = await k.as("maya", (tx, c) => createRow(tx, c, timeOff, "requests", { values: { from: "2026-12-07", to: "2026-12-08" } }));
    await expect(k.as("maya", (tx, c) => moveStep(tx, c, id, "approved"))).rejects.toThrow("Maya Chen is yours, so someone else moves it to Signed off.");
    await k.as("priya", (tx, c) => moveStep(tx, c, id, "approved"));
  });

  it("a step only the submitter can move a row out of", async () => {
    const file = timeOffFile();
    file.sheets[0]!.steps![0]!.moveOut = "submitter";
    file.sheets[0]!.steps![1]!.moveIn = "anyone";
    file.sheets[0]!.steps![2]!.moveIn = "anyone";
    await k.as("ada", (tx, c) => saveVersion(tx, c, timeOff, file, { source: "customize", event: "customize.saved" }));
    const { id } = await k.as("maya", (tx, c) => createRow(tx, c, timeOff, "requests", { values: { from: "2026-12-14", to: "2026-12-14" } }));
    await expect(k.as("priya", (tx, c) => moveStep(tx, c, id, "approved"))).rejects.toThrow("Only the person who asked can move Maya Chen on from Submitted.");
    expect(await k.as("priya", (tx, c) => movesFor(tx, c, id))).toEqual([]);
    await k.as("maya", (tx, c) => moveStep(tx, c, id, "approved"));
    await k.as("ada", (tx, c) => saveVersion(tx, c, timeOff, timeOffFile(), { source: "customize", event: "customize.saved" }));
  });
});

describe("deleteRows: soft, and gone for every read", () => {
  it("can't be read, listed, counted or linked to", async () => {
    const { id } = await newContract({ customer: "Quill Media", value: 1_200_000 });
    const before = await k.as("ada", (tx, c) => countRows(tx, c, contracts, "contracts"));
    await k.as("ada", (tx, c) => deleteRows(tx, c, [id]));

    await k.as("ada", async (tx, c) => {
      await expect(getRow(tx, c, id)).rejects.toThrow("That row doesn't exist, or you can't see it.");
      expect((await listRows(tx, c, contracts, "contracts")).some((r) => r.id === id)).toBe(false);
      expect(await countRows(tx, c, contracts, "contracts")).toBe(before - 1);
      await expect(updateRow(tx, c, id, { value: 1 })).rejects.toThrow("doesn't exist");
      expect(await lastAudit(tx)).toMatchObject({ event: "row.deleted", details: { sheet: "Contracts", rows: ["Quill Media"], alsoDeleted: 0 } });
      // Still in the table, marked deleted.
      expect((await tx.select({ d: rows.deletedAt }).from(rows).where(eq(rows.id, id)))[0]!.d).not.toBeNull();
    });

    // A link to it is refused.
    const withContacts = contractsFile([k.id.ada]);
    withContacts.sheets.push({
      id: "contacts",
      name: "Contacts",
      kind: "list",
      titleColumn: "name",
      columns: [
        { id: "name", name: "Name", type: "text" },
        { id: "contract", name: "Contract", type: "link", link: { sheet: "contracts" } },
      ],
    });
    withContacts.roles[1]!.sheets = ["contracts"];
    await k.as("ada", (tx, c) => saveVersion(tx, c, contracts, withContacts, { source: "customize", event: "customize.saved" }));
    await expect(k.as("ada", (tx, c) => createRow(tx, c, contracts, "contacts", { values: { name: "Ravi Shah", contract: id } }))).rejects.toThrow(
      "Contract must be a row you can see.",
    );
  });

  it("deletes the rows in the same capability that link to it", async () => {
    const { id } = await newContract({ customer: "Kova", value: 1_080_000 });
    const contact = (name: string) => k.as("ada", (tx, c) => createRow(tx, c, contracts, "contacts", { values: { name, contract: id } }));
    const [a, b] = [await contact("Billing"), await contact("Legal")];
    const r = await k.as("ada", (tx, c) => deleteRows(tx, c, [id]));
    expect(r).toEqual({ deleted: 1, alsoDeleted: 2, alsoEmptied: 0 });
    await k.as("ada", async (tx, c) => {
      for (const x of [a, b]) await expect(getRow(tx, c, x.id)).rejects.toThrow("doesn't exist");
    });
  });
});

describe("bulkUpdate and importRows", () => {
  it("a bulk change is one audit entry listing the rows", async () => {
    const ids = [(await newContract({ customer: "A1", value: 1 })).id, (await newContract({ customer: "A2", value: 2 })).id];
    await k.as("ada", async (tx, c) => {
      const before = await auditCount(tx);
      await bulkUpdate(tx, c, ids, { values: { owner: k.id.rita } });
      expect(await auditCount(tx)).toBe(before + 1);
      expect(await lastAudit(tx)).toMatchObject({ event: "rows.bulk_updated", details: { rows: ["A1", "A2"], change: { columns: ["owner"] } } });
    });
  });

  it("an import is all or nothing, at any step, with one audit entry", async () => {
    await k.as("ada", async (tx, c) => {
      const before = await tx.$count(rows);
      await expect(
        importRows(tx, c, contracts, "contracts", [{ values: { customer: "Lumen Retail", value: 2_400_000, status: "active" } }, { values: { customer: "Broken" } }], { source: "contracts.csv" }),
      ).rejects.toThrow("Row 2: Value a year is required.");
      expect(await tx.$count(rows)).toBe(before);
    });
    const ids = await k.as("ada", (tx, c) =>
      importRows(tx, c, contracts, "contracts", [{ values: { customer: "Lumen Retail", value: 2_400_000, status: "active" } }], { source: "contracts.csv" }),
    );
    await k.as("ada", async (tx, c) => {
      expect((await getRow(tx, c, ids[0]!)).stepId).toBe("active");
      expect(await lastAudit(tx)).toMatchObject({ event: "import.done", details: { file: "contracts.csv", rows: 1 } });
    });
  });
});
