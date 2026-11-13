import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditEntries, people } from "@/db/schema";
import { TEAM_TEMPLATE } from "@/lib/team-template";
import { freshWorkspace } from "@/tests/helpers";
import { checkTeamCsv } from "../people";
import { withWorkspace } from "../tx";
import { draftFromFile, draftFromReading, finishTeam, leadsTable, setupRoles, teamSummary, type TeamReading } from "./team";

const fromTemplate = () => draftFromFile(checkTeamCsv(TEAM_TEMPLATE), "team.csv");

describe("setup roles", () => {
  it("gives the 14 their roles by the fixed rules, title before reporting line", () => {
    const roles = Object.fromEntries(fromTemplate().people.map((p) => [p.name, p.role]));
    expect(roles).toMatchObject({ "Wade Wilson": "Founder", "Priya Nair": "Team lead", "Dev Kumar": "Team lead", Krishna: "Ops", "Jon Bell": "Ops", "Lena Ortiz": "Finance", "Maya Chen": "Member", "Aisha Khan": "Member" });
    expect(new Set(Object.values(roles)).size).toBe(5);
  });

  it("reads IT only in capitals", () => {
    const one = (title: string) => setupRoles([{ key: "a", name: "A", email: null, title, team: null, manager: "b" }])[0]!.role;
    expect(one("IT support")).toBe("Ops");
    expect(one("Head of it")).toBe("Member");
    expect(one("Office manager")).toBe("Ops");
    expect(one("Finance lead")).toBe("Finance");
  });
});

describe("2e's leads", () => {
  it("lists the founder and those who report to the founder, with the others who report to them", () => {
    const t = leadsTable(fromTemplate());
    expect(t.leads.map((l) => [l.name, l.title, l.reports, l.role])).toEqual([
      ["Wade Wilson", "Founder", 0, "Founder"],
      ["Priya Nair", "Engineering lead", 4, "Team lead"],
      ["Dev Kumar", "Growth lead", 3, "Team lead"],
      ["Krishna", "Operations", 2, "Ops"],
      ["Lena Ortiz", "Accountant, part time", 0, "Finance"],
    ]);
    expect(t.others).toBe(9);
  });
});

describe("prompt 8's team reading", () => {
  const SAID = "I'm the founder, wade@fernwood.dev. Priya leads engineering and Dev leads growth.";
  const reading: TeamReading = {
    people: [
      { name: "Wade Wilson", email: "wade@fernwood.dev", title: "Founder", manager: null, team: "Leadership" },
      // A guessed email: it isn't in what the admin wrote, so it counts as missing.
      { name: "Priya", email: "priya@fernwood.dev", title: "Engineering lead", manager: "Wade Wilson", team: "Engineering" },
      { name: "Dev", email: null, title: "Growth lead", manager: "wade@fernwood.dev", team: "Growth" },
      { name: "Sam", email: null, title: null, manager: "Zed", team: null },
    ],
    teams: ["Leadership", "Engineering", "Growth"],
    problems: [],
  };

  it("accepts an email only when the admin wrote it, and asks for the rest", () => {
    const d = draftFromReading(reading, SAID, [], null);
    expect(d.people.map((p) => [p.name, p.email, p.manager, p.role])).toEqual([
      ["Wade Wilson", "wade@fernwood.dev", null, "Founder"],
      ["Priya", null, "wade@fernwood.dev", "Member"],
      ["Dev", null, "wade@fernwood.dev", "Member"],
      ["Sam", null, null, "Member"],
    ]);
    expect(d.problems).toEqual(["What is Priya's work email?", "What is Dev's work email?", "What is Sam's work email?", "Sam's manager Zed isn't in the team, so I left it empty."]);
  });

  it("takes an email the file gives, with its start date", () => {
    const known = fromTemplate().people;
    const d = draftFromReading(reading, SAID + "\n" + TEAM_TEMPLATE, known, "team.xlsx");
    expect(d.people.find((p) => p.name === "Priya")).toMatchObject({ email: "priya@fernwood.dev", startDate: "2024-03-01" });
  });
});

describe("finishTeam", () => {
  it("saves everyone with an email, managers and roles, and the owner's own line", async () => {
    const { workspaceId, personId } = await freshWorkspace("wade@fernwood.dev");
    const ctx = { workspaceId, actor: { id: personId, email: "wade@fernwood.dev" } };
    const r = await withWorkspace({ workspaceId, personId }, (tx) => finishTeam(tx, ctx, fromTemplate()));
    expect(r).toMatchObject({ added: 13, skipped: 1, leftOut: [], noManager: [] });
    const all = await withWorkspace({ workspaceId }, (tx) => tx.select().from(people));
    const by = (e: string) => all.find((p) => p.email === `${e}@fernwood.dev`)!;
    expect(by("wade")).toMatchObject({ title: "Founder", team: "Leadership", setupRole: "Founder", managerId: null, isAdmin: true });
    expect(by("maya")).toMatchObject({ managerId: by("priya").id, setupRole: "Member", startDate: "2024-06-10" });
    expect(by("krishna").setupRole).toBe("Ops");
    expect(await withWorkspace({ workspaceId }, teamSummary)).toEqual({ people: 14, teams: 5, roles: 5 });
    const events = await withWorkspace({ workspaceId }, (tx) => tx.select().from(auditEntries).where(eq(auditEntries.event, "people.imported")));
    expect(events).toHaveLength(1);
  });

  it("leaves out people with no email, and saves their reports with no manager", async () => {
    const { workspaceId, personId } = await freshWorkspace("wade@fernwood.dev");
    const ctx = { workspaceId, actor: { id: personId, email: "wade@fernwood.dev" } };
    const reading: TeamReading = {
      people: [
        { name: "Wade Wilson", email: "wade@fernwood.dev", title: "Founder", manager: null, team: null },
        { name: "Priya", email: null, title: "Engineering lead", manager: "Wade Wilson", team: null },
        { name: "Maya", email: "maya@fernwood.dev", title: "Backend engineer", manager: "Priya", team: null },
      ],
      teams: [],
      problems: [],
    };
    const d = draftFromReading(reading, "wade@fernwood.dev maya@fernwood.dev", [], null);
    const r = await withWorkspace({ workspaceId, personId }, (tx) => finishTeam(tx, ctx, d));
    expect(r).toMatchObject({ added: 1, leftOut: ["Priya"], noManager: ["Maya"] });
    const [maya] = await withWorkspace({ workspaceId }, (tx) => tx.select().from(people).where(eq(people.email, "maya@fernwood.dev")));
    expect(maya).toMatchObject({ managerId: null, managerFlag: null });
  });

  it("is for admins only", async () => {
    const { workspaceId, personId } = await freshWorkspace();
    const [maya] = await withWorkspace({ workspaceId }, (tx) => tx.insert(people).values({ workspaceId, name: "Maya", email: "maya@x.dev" }).returning());
    await expect(withWorkspace({ workspaceId, personId }, (tx) => finishTeam(tx, { workspaceId, actor: { id: maya!.id, email: "maya@x.dev" } }, fromTemplate()))).rejects.toThrow("Only admins");
  });
});
