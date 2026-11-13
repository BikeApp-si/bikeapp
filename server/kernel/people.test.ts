import { describe, expect, it } from "vitest";
import { checkTeamCsv, deriveTeams, importPeople, teamFromTitle } from "./people";
import { createWorkspace } from "./workspaces";
import { withWorkspace } from "./tx";
import { people, auditEntries } from "@/db/schema";

const HEADER = "Full name,Work email,Job title,Manager email,Start date\n";

describe("checkTeamCsv (developer notes §4)", () => {
  it("reads the template, with quoted commas", () => {
    const r = checkTeamCsv(HEADER + 'Wade Wilson,wade@fernwood.dev,Founder,,2024-01-15\nLena Ortiz,lena@fernwood.dev,"Accountant, part time",wade@fernwood.dev,2024-07-01\n');
    expect(r.problems).toEqual([]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[1]).toMatchObject({ title: "Accountant, part time", managerEmail: "wade@fernwood.dev", startDate: "2024-07-01" });
  });
  it("needs a header row with name and email", () => {
    expect(checkTeamCsv("Wade,wade@x.dev\n").problems[0]).toContain("headers");
    expect(checkTeamCsv("").problems[0]).toBe("The file is empty.");
  });
  it("keeps the first of duplicate emails and lists the rest", () => {
    const r = checkTeamCsv(HEADER + "A,a@x.dev,,,\nB,A@x.dev,,,\n");
    expect(r.rows.map((x) => x.name)).toEqual(["A"]);
    expect(r.problems[0]).toContain("Row 3");
  });
  it("keeps a row whose manager isn't in the file, and flags it", () => {
    const r = checkTeamCsv(HEADER + "A,a@x.dev,,b@x.dev,\n");
    expect(r.rows).toHaveLength(1);
    expect(r.flagged[0]).toContain("b@x.dev");
  });
  it("asks about ambiguous dates instead of guessing", () => {
    const r = checkTeamCsv(HEADER + "A,a@x.dev,,,03/02/2024\n");
    expect(r.rows[0]!.startDate).toBeNull();
    expect(r.questions[0]).toContain("03/02/2024");
  });
  it("lists other headers for the import mapping", () => {
    expect(checkTeamCsv("Full name,Work email,Desk\nA,a@x.dev,4\n").otherHeaders).toEqual(["Desk"]);
  });
});

// The template from developer notes §4, without its Team column.
const NOTES_CSV = `Full name,Work email,Job title,Manager email,Start date
Wade Wilson,wade@fernwood.dev,Founder,,2024-01-15
Priya Nair,priya@fernwood.dev,Engineering lead,wade@fernwood.dev,2024-03-01
Maya Chen,maya@fernwood.dev,Backend engineer,priya@fernwood.dev,2024-06-10
Dev Kumar,dev@fernwood.dev,Growth lead,wade@fernwood.dev,2024-04-08
Rita Gomez,rita@fernwood.dev,Account manager,dev@fernwood.dev,2025-01-13
Krishna,krishna@fernwood.dev,Operations,wade@fernwood.dev,2024-05-06
Jon Bell,jon@fernwood.dev,IT and office,krishna@fernwood.dev,2025-02-17
Lena Ortiz,lena@fernwood.dev,"Accountant, part time",wade@fernwood.dev,2024-07-01
`;

describe("teams", () => {
  it("are read from the Team column when the file has one", () => {
    const r = checkTeamCsv("Full name,Work email,Job title,Team,Manager email,Start date\nLena Ortiz,lena@x.dev,\"Accountant, part time\",Finance,,2024-07-01\n");
    expect(r.teamsDerived).toBe(false);
    expect(r.rows[0]).toMatchObject({ team: "Finance", title: "Accountant, part time", startDate: "2024-07-01" });
  });

  it("come from the manager chain when there is no Team column", () => {
    const r = checkTeamCsv(NOTES_CSV);
    expect(r.teamsDerived).toBe(true);
    expect(Object.fromEntries(r.rows.map((p) => [p.name, p.team]))).toEqual({
      "Wade Wilson": "Leadership",
      "Priya Nair": "Engineering",
      "Maya Chen": "Engineering",
      "Dev Kumar": "Growth",
      "Rita Gomez": "Growth",
      Krishna: "Operations",
      "Jon Bell": "Operations",
      "Lena Ortiz": "Accountant", // the admin changes it on 2e
    });
  });

  it("leave a broken chain empty instead of guessing", () => {
    const rows = deriveTeams([
      { name: "A", email: "a@x.dev" },
      { name: "B", email: "b@x.dev", managerEmail: "gone@x.dev" },
      { name: "C", email: "c@x.dev", managerEmail: "d@x.dev" },
      { name: "D", email: "d@x.dev", managerEmail: "c@x.dev" },
    ]);
    expect(rows.map((r) => r.team)).toEqual(["Leadership", null, null, null]);
  });

  it("are named from the lead's title", () => {
    expect(teamFromTitle("Engineering lead")).toBe("Engineering");
    expect(teamFromTitle("Head of Sales")).toBe("Sales");
    expect(teamFromTitle("Marketing manager")).toBe("Marketing");
    expect(teamFromTitle("Accountant, part time")).toBe("Accountant");
    expect(teamFromTitle("Lead")).toBeNull();
  });
});

describe("importPeople", () => {
  it("saves people with managers in one transaction and one Audit entry", async () => {
    const { workspaceId } = await createWorkspace({ subdomain: "import-test", name: "Import Test", timeZone: "UTC", admin: { name: "Ada", email: "ada@it.dev" } });
    const ctx = { workspaceId };
    const rows = checkTeamCsv(HEADER + "Ada,ada@it.dev,,,\nBo,bo@it.dev,Dev,ada@it.dev,2025-01-02\nCy,cy@it.dev,,zed@it.dev,\n").rows;
    const result = await withWorkspace(ctx, (tx) => importPeople(tx, ctx, "ada@it.dev", rows, "csv"));
    expect(result).toEqual({ added: 2, skipped: 1, flagged: 1 });

    const saved = await withWorkspace(ctx, (tx) => tx.select().from(people));
    const ada = saved.find((p) => p.email === "ada@it.dev")!;
    expect(saved.find((p) => p.email === "bo@it.dev")).toMatchObject({ managerId: ada.id, startDate: "2025-01-02" });
    expect(saved.find((p) => p.email === "cy@it.dev")).toMatchObject({ managerId: null, managerFlag: "zed@it.dev" });

    const events = await withWorkspace(ctx, (tx) => tx.select().from(auditEntries));
    expect(events.map((e) => e.event).sort()).toEqual(["people.imported", "workspace.created"]);
  });
});
