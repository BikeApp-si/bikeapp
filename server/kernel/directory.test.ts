import { beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { auditEntries, people } from "@/db/schema";
import { kernelWorkspace } from "@/tests/kernel";
import type { CapabilityFile } from "./schema/file";
import { addPerson, checkNewPerson, importPeopleCsv, listPeople, rolesOf } from "./directory";

let k: Awaited<ReturnType<typeof kernelWorkspace>>;

beforeAll(async () => {
  k = await kernelWorkspace();
});

const file = (manager: string): CapabilityFile => ({
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
      ],
    },
  ],
  roles: [
    { id: "finance", name: "Finance", members: { kind: "people", people: [manager] }, can: ["see"], scope: "all" },
    { id: "requesters", name: "Requesters", members: { kind: "everyone" }, can: ["see", "add"], scope: "own", scopeColumns: { expenses: { column: "who" } } },
  ],
  rules: [],
  later: [],
});

describe("People", () => {
  it("lists everyone with their manager, and searches and filters by team", async () => {
    await k.as("ada", (tx) => tx.update(people).set({ team: "Engineering" }).where(eq(people.id, k.id.maya)));
    const all = await k.as("maya", (tx) => listPeople(tx));
    expect(all.map((p) => p.name)).toEqual(["Ada Admin", "Priya Nair", "Rita Gomez", "Maya Chen", "Omar Ali"]);
    expect(all.find((p) => p.name === "Maya Chen")?.manager?.name).toBe("Priya Nair");
    expect((await k.as("maya", (tx) => listPeople(tx, { search: "GOMEZ" }))).map((p) => p.name)).toEqual(["Rita Gomez"]);
    expect((await k.as("maya", (tx) => listPeople(tx, { team: "Engineering" }))).map((p) => p.name)).toEqual(["Maya Chen"]);
  });

  it("names the roles a person holds in each capability", async () => {
    await k.create(file(k.id.rita));
    expect(await k.as("ada", (tx, c) => rolesOf(tx, c, k.id.rita))).toEqual(["Finance in Spend", "Requesters in Spend"]);
    expect(await k.as("ada", (tx, c) => rolesOf(tx, c, k.id.maya))).toEqual(["Requesters in Spend"]);
  });

  it("adds a person as an admin, with an Audit entry and no roles", async () => {
    const { id } = await k.as("ada", (tx, c) => addPerson(tx, c, { name: "Leo Grant", email: "Leo@Example.dev", title: "Sales executive", managerId: k.id.rita, startDate: "2026-11-10" }));
    const leo = (await k.as("ada", (tx) => listPeople(tx))).find((p) => p.id === id)!;
    expect(leo).toMatchObject({ email: "leo@example.dev", manager: { name: "Rita Gomez" }, startDate: "2026-11-10", isAdmin: false });
    const [entry] = await k.as("ada", (tx) => tx.select().from(auditEntries).where(eq(auditEntries.event, "person.added")).orderBy(desc(auditEntries.seq)).limit(1));
    expect(entry?.details).toEqual({ person: "leo@example.dev", name: "Leo Grant" });
    expect(await k.as("ada", (tx, c) => rolesOf(tx, c, id))).toEqual(["Requesters in Spend"]); // only the role everyone has
  });

  it("refuses a duplicate email, a bad date, and anyone who isn't an admin", async () => {
    await expect(k.as("ada", (tx, c) => addPerson(tx, c, { name: "Leo Again", email: "leo@example.dev" }))).rejects.toThrow(/already has that email/);
    await expect(k.as("ada", (tx, c) => addPerson(tx, c, { name: "Kim", email: "kim@example.dev", startDate: "2026-02-30" }))).rejects.toThrow(/real date/);
    await expect(k.as("maya", (tx, c) => addPerson(tx, c, { name: "Kim", email: "kim@example.dev" }))).rejects.toThrow(/Only admins/);
    expect(checkNewPerson({ name: "", email: "nope" })).toEqual({ name: "Full name is needed.", email: "That isn't an email address." });
  });

  it("imports a team CSV all or nothing", async () => {
    const bad = "Full name,Work email\nNina Park,nina@example.dev\nJon Bell,not-an-email\n";
    await expect(k.as("ada", (tx, c) => importPeopleCsv(tx, c, { name: "team.csv", text: bad }))).rejects.toThrow(/isn't an email/);
    expect((await k.as("ada", (tx) => listPeople(tx, { search: "nina" }))).length).toBe(0);
    const good = "Full name,Work email,Job title,Team,Manager email\nNina Park,nina@example.dev,Marketing manager,Growth,leo@example.dev\n";
    expect(await k.as("ada", (tx, c) => importPeopleCsv(tx, c, { name: "team.csv", text: good }))).toEqual({ added: 1, skipped: 0, flagged: 0 });
    expect((await k.as("ada", (tx) => listPeople(tx, { search: "nina" })))[0]?.manager?.name).toBe("Leo Grant");
  });
});
