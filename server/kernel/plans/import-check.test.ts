import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseCsv } from "@/lib/csv";
import { checkImport, FOUND_MAX, foundChoices, peopleKeys, readAmount, readDate, type Mapping } from "./import-check";
import type { Sheet } from "../schema/file";
import { contractRules, contracts } from "./fixtures";
import { checkPlan } from "./plan";

// 5g: contracts.csv read into the planned Contracts sheet.

const team = [
  { id: "u", name: "Wade Wilson", email: "wade@fernwood.dev" },
  { id: "k", name: "Krishna", email: "krishna@fernwood.dev" },
  { id: "r", name: "Rita Gomez", email: "rita@fernwood.dev" },
  { id: "rk", name: "Rita Kim", email: "ritak@fernwood.dev" },
];
const people = peopleKeys(team);
const plan = checkPlan({ capability: contracts, rules: contractRules, alsoChanges: [] }, { newId: "n", files: new Map(), people: new Map(team.map((p) => [p.email, p.id])) });
const sheet = plan.file.sheets[0]!;
const table = parseCsv(readFileSync("tests/files/contracts.csv", "utf8"));
const m = (from: string, to: string, format: string | null = null): Mapping => ({ from, to, format, values: [] });
const mapping = [m("Client", "Customer"), m("ARR", "Value a year"), m("Start date", "Start", "MM/DD/YYYY"), m("Renewal", "Renews on", "MM/DD/YYYY"), m("Account owner", "Owner"), m("Stage", "Status")];

describe("reading a file into a planned sheet", () => {
  it("reads all 12 contracts, by column id, at their steps", () => {
    const out = checkImport(sheet, table, mapping, people);
    expect(out.problems).toEqual([]);
    expect(out.rows).toHaveLength(12);
    expect(out.rows[0]).toEqual({ values: { customer: "Northwind", value_a_year: 3_840_000, start: "2025-11-15", renews_on: "2026-11-14", owner: "k", status: "renewal_due" } });
    // An owner not in People is left for the default (you); a renewal date left empty is filled by its default.
    expect(out.rows[4]!.values).not.toHaveProperty("owner");
    expect(out.rows[8]!.values).not.toHaveProperty("renews_on");
    expect(out.rows[11]!.values).toEqual({ customer: "Quill Media", value_a_year: 1_200_000, owner: "r", status: "draft" });
  });

  it("lists the 2 rows that need a check, and what it will do, as 5g shows", () => {
    expect(checkImport(sheet, table, mapping, people).checks).toEqual([
      { row: "Brightline", issue: "Owner “J. Bell” is not in People", action: "Set the owner to you" },
      { row: "Sable Analytics", issue: "No renewal date", action: "Set Renews on to Start + 1 year" },
    ]);
  });

  it("shows each file column, where it goes and the first row's value", () => {
    const out = checkImport(sheet, table, mapping, people);
    expect(out.mapping).toEqual([
      { from: "Client", to: "Customer", example: "Northwind" },
      { from: "ARR", to: "Value a year", example: "$38,400" },
      { from: "Start date", to: "Start", example: "Nov 15, 2025" },
      { from: "Renewal", to: "Renews on", example: "Nov 14, 2026" },
      { from: "Account owner", to: "Owner (matched to People)", example: "Krishna" },
      { from: "Stage", to: "Status: Draft, Signed…", example: "Renewal due" },
    ]);
    expect(out.unmapped).toEqual(["Notes", "Region", "Contract ID"]);
  });

  it("says what a mapping names that isn't there, for the AI's retry", () => {
    expect(checkImport(sheet, table, [...mapping, m("Region", "Territory"), m("Signed by", "Owner")], people).problems).toEqual([
      "Contracts has no column “Territory” to fill.",
      "The file has no column “Signed by”.",
    ]);
  });

  it("leaves out a row a required column can't be read for", () => {
    const bad = table.map((r, i) => (i === 2 ? r.map((c, j) => (j === 1 ? "lots" : c)) : r));
    const out = checkImport(sheet, bad, mapping, people);
    expect(out.rows).toHaveLength(11);
    expect(out.checks[0]).toEqual({ row: "Acme Health", issue: "ARR “lots” isn't an amount", action: "Leave this row out" });
  });

  it("reads dates and amounts as files write them; a person by name, unique first name or email", () => {
    expect(readDate("03/02/2024", "MM/DD/YYYY")).toBe("2024-03-02");
    expect(readDate("03/02/2024", "DD/MM/YYYY")).toBe("2024-02-03");
    expect(readDate("Mar 1, 2025", null)).toBe("2025-03-01");
    expect(readDate("2025-02-30", null)).toBeNull();
    expect(readAmount("$38,400.50")).toBe(3_840_050);
    // A company in India (M26): "14 Nov 2026", and rupees in Indian grouping.
    expect(readDate("14 Nov 2026", null)).toBe("2026-11-14");
    expect(readAmount("₹12,34,567")).toBe(123_456_700);
    expect(people.byKey.get("krishna")).toBe("k");
    expect(people.byKey.get("rita")).toBeUndefined(); // two Ritas
    expect(people.byKey.get("rita@fernwood.dev")).toBe("r");
  });
});

describe("choice values a build's design missed (M25)", () => {
  const sheet: Sheet = {
    id: "requests",
    name: "Requests",
    kind: "list",
    titleColumn: "who",
    columns: [
      { id: "who", name: "Who", type: "text" },
      { id: "type", name: "Leave type", type: "choice", options: [{ id: "vacation", name: "Vacation" }, { id: "sick", name: "Sick" }] },
      { id: "note", name: "Note", type: "choice", options: [{ id: "a", name: "A" }] },
    ],
  };
  const map = (from: string, to: string, values: Mapping["values"] = []): Mapping => ({ from, to, format: null, values });
  const table = [["Employee", "Leave Type", "Note"], ...Array.from({ length: 12 }, (_, i) => [`P${i}`, ["Vacation", "sick", "Personal", "personal", "Parental"][i % 5]!, `free text ${i}`])];

  it("finds each missing value once, as the file first writes it; a value the mapping translates is not missing", () => {
    expect(foundChoices(sheet, table, [map("Employee", "Who"), map("Leave Type", "Leave type")])).toEqual([{ column: "Leave type", values: ["Personal", "Parental"] }]);
    expect(foundChoices(sheet, table, [map("Leave Type", "Leave type", [{ file: "Parental", means: "Vacation" }])])).toEqual([{ column: "Leave type", values: ["Personal"] }]);
  });

  it("takes the file's own value when the mapping's meaning names no choice (G1)", () => {
    const said = [map("Leave Type", "Leave type", [{ file: "Personal", means: "No matching choice (sheet offers only Vacation or Sick); needs a person to decide" }])];
    expect(foundChoices(sheet, table, said)).toEqual([{ column: "Leave type", values: ["Personal", "Parental"] }]);
  });

  it("leaves a column with more than a few new values alone: it's free text, not choices", () => {
    expect(foundChoices(sheet, table, [map("Note", "Note")])).toEqual([]);
    expect(FOUND_MAX).toBe(5);
  });

  it("leaves a column alone when a value is longer than a choice's name may be (M28)", () => {
    const long = [["Employee", "Leave Type"], ["A", "Personal"], ["B", "Taken for a family wedding out of state, agreed with Priya before the trip was booked"]];
    expect(foundChoices(sheet, long, [map("Leave Type", "Leave type")])).toEqual([]);
  });
});
