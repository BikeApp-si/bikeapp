import { describe, expect, it } from "vitest";
import { salesLeadsFile } from "../fixtures";
import type { CapabilityFile } from "../schema/file";
import { validateFile } from "../schema/validate";
import { plainProblem, refusal } from "./words";

// C1: the kernel's problems as the admin reads them. Each case is the message validate.ts really writes.

const problems = (f: CapabilityFile) => {
  const r = validateFile(f);
  return r.ok ? [] : r.errors;
};

describe("plain-word refusals", () => {
  it("says the Sales leads refusal without its prefix", () => {
    const f = salesLeadsFile();
    f.sheets.push({ id: "companies", name: "Companies", kind: "list", titleColumn: "name", columns: [{ id: "name", name: "Name", type: "text" }] });
    const [p] = problems(f);
    expect(p).toBe("Role Lead owners › Companies: needs a person column that says whose each row is.");
    expect(refusal([p!])).toBe("I can't apply that. Lead owners see only their own rows, and nothing in Companies says whose a row is. Say who should see Companies, or add a person column such as Owner.");
  });

  it("says a column that can't decide whose a row is plainly, with no id", () => {
    const f = salesLeadsFile();
    f.roles[1]!.scopeColumns = { leads: { column: "company" } };
    const [p] = problems(f);
    expect(plainProblem(p!)).toBe("Lead owners can't see Leads that way: whose a row is must come from a person on it, or one link away.");
  });

  it("says the limits as limits of this version, without Later", () => {
    const f = salesLeadsFile();
    for (const id of ["a", "b", "c", "d", "e", "f"]) f.sheets.push({ id, name: id.toUpperCase(), kind: "list", titleColumn: "name", columns: [{ id: "name", name: "Name", type: "text" }] });
    f.roles = f.roles.filter((r) => r.scope === "all");
    expect(problems(f).map(plainProblem)).toEqual(["Sales leads can have at most 6 sheets in this version, and this would make more."]);
  });

  it("drops the prefix from any other role problem and leaves other problems as they are", () => {
    expect(plainProblem("Role Lead owners: lists steps to move but can't move steps.")).toBe("Lead owners: lists steps to move but can't move steps.");
    expect(plainProblem("Equipment › Plan: links to a sheet “Plans” that doesn't exist.")).toBe("Plan in Equipment links to a sheet “Plans” that doesn't exist.");
    expect(plainProblem("Hired has 5 candidates, so it can't be removed in this version. It can be renamed instead.")).toBe("Hired has 5 candidates, so it can't be removed in this version. It can be renamed instead.");
  });
});
