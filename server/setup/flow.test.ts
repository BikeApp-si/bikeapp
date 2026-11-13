import { afterEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { aiCalls, auditEntries, people, workspaces } from "@/db/schema";
import { useProvider } from "@/server/ai/gateway";
import { readSetup } from "@/server/kernel/setup/state";
import { leadsTable } from "@/server/kernel/setup/team";
import { SETUP, newFernwood } from "@/tests/setup";
import { continueToTeam, finishSetup, sendOrganization, sendTeam, skipOrganization, skipTeam } from "./flow";

// Setup 2b → 2f from the messages on the screens, replayed from recorded answers in a new workspace.

afterEach(() => useProvider(null));

const lastReply = async (w: Awaited<ReturnType<typeof newFernwood>>) => (await w.k(readSetup)).state.messages.at(-1)!;

describe("setup from the screens' messages", () => {
  it("2b → 2c → Continue → 2d with team.xlsx → 2e reply → Finish", async () => {
    const w = await newFernwood();
    await w.say((tx, c) => sendOrganization(tx, c, SETUP.organization, []));
    const org = await lastReply(w);
    expect(org).toMatchObject({ from: "bike", status: "done", text: "Here’s what I collected. Reply to correct anything." });
    expect(org.from === "bike" && org.status === "done" && org.organization).toMatchObject({
      name: "Fernwood Labs",
      address: { street: "210 Congress Ave", city: "Austin", region: "TX", country: "US" },
      website: "fernwood.dev",
      products: ["Fernwood CI", "Fernwood Trace"],
      missing: [],
    });
    // Nothing is saved before Continue.
    expect((await w.k((tx) => tx.select().from(workspaces)))[0]!.city).toBeNull();
    await w.k(continueToTeam);
    const [ws] = await w.k((tx) => tx.select().from(workspaces));
    expect(ws).toMatchObject({ city: "Austin", country: "US", currency: "USD", holidayCountry: "US", fiscalYearStart: 1, website: "fernwood.dev", setupDoneAt: null });

    const xlsx = await w.upload("tests/files/team.xlsx");
    await w.say((tx, c) => sendTeam(tx, c, SETUP.team, [xlsx]));
    const team = await lastReply(w);
    expect(team).toMatchObject({ status: "done", text: "I found 14 people in team.xlsx. These are the leads; the other 9 report to them." });
    const draft = team.from === "bike" && team.status === "done" ? team.team! : null;
    expect(leadsTable(draft!).leads.map((l) => [l.name, l.reports, l.role])).toEqual([
      ["Wade Wilson", 0, "Founder"],
      ["Priya Nair", 4, "Team lead"],
      ["Dev Kumar", 3, "Team lead"],
      ["Krishna", 2, "Ops"],
      ["Lena Ortiz", 0, "Finance"],
    ]);
    // Start dates come from the file, not the model.
    expect(draft!.people.find((p) => p.name === "Maya Chen")!.startDate).toBe("2024-06-10");

    await w.say((tx, c) => sendTeam(tx, c, SETUP.correction, []));
    const corrected = await lastReply(w);
    const after = corrected.from === "bike" && corrected.status === "done" ? corrected.team! : null;
    // The reply beats both the file and the founder default.
    expect(after!.people.find((p) => p.name === "Lena Ortiz")).toMatchObject({ manager: "krishna@fernwood.dev", role: "Finance" });
    expect(leadsTable(after!).leads.map((l) => l.name)).toEqual(["Wade Wilson", "Priya Nair", "Dev Kumar", "Krishna"]);
    expect((await w.k((tx) => tx.select().from(people))).length).toBe(1);

    await w.k(finishSetup);
    const all = await w.k((tx) => tx.select().from(people));
    const by = (e: string) => all.find((p) => p.email === `${e}@fernwood.dev`)!;
    expect(all).toHaveLength(14);
    expect(by("lena")).toMatchObject({ managerId: by("krishna").id, setupRole: "Finance" });
    expect(by("wade")).toMatchObject({ title: "Founder", setupRole: "Founder", isAdmin: true });
    expect(by("jon")).toMatchObject({ managerId: by("krishna").id, setupRole: "Ops" });
    const done = await w.k(readSetup);
    expect(done.doneAt).not.toBeNull();
    expect(done.state).toEqual({ step: "done", messages: [], done: { leftOut: [], noManager: [] } });
    const events = (await w.k((tx) => tx.select().from(auditEntries).orderBy(asc(auditEntries.seq)))).map((e) => e.event);
    expect(events).toEqual(["workspace.created", "settings.updated", "people.imported"]);
    // Setup can't be changed once it is done.
    await expect(w.k((tx, c) => sendTeam(tx, c, "Add Sam", []))).rejects.toThrow("Setup is done");
  });

  it("a typed team: emails only as written, the rest asked for and left out at Finish", async () => {
    const w = await newFernwood();
    await w.k(skipOrganization);
    await w.say((tx, c) => sendTeam(tx, c, SETUP.typed, []));
    const reply = await lastReply(w);
    const d = reply.from === "bike" && reply.status === "done" ? reply.team! : null;
    expect(reply).toMatchObject({ text: "I found 6 people in your message. These are the leads; the other 2 report to them." });
    expect(d!.people.map((p) => [p.name, p.email, p.role])).toEqual([
      ["Wade Wilson", "wade@fernwood.dev", "Founder"],
      ["Priya Nair", null, "Team lead"],
      ["Maya Chen", null, "Member"],
      ["Omar Ali", null, "Member"],
      ["Dev Kumar", null, "Member"],
      ["Lena Ortiz", "lena@fernwood.dev", "Finance"],
    ]);
    expect(d!.problems).toEqual(expect.arrayContaining(["What is Priya Nair's work email?", "What is Dev Kumar's work email?"]));
    await w.k(finishSetup);
    const all = await w.k((tx) => tx.select().from(people));
    expect(all.map((p) => p.email).sort()).toEqual(["lena@fernwood.dev", "wade@fernwood.dev"]);
    expect((await w.k(readSetup)).state.done).toEqual({ leftOut: ["Priya Nair", "Maya Chen", "Omar Ali", "Dev Kumar"], noManager: [] });
  });

  // Leads report to the founder by default (prompt 8, developer notes §8), but never over what the admin
  // says: in one message here, and in a reply on 2e ("Lena reports to Krishna") in the first test.
  it("an explicit line from the admin beats the founder default", async () => {
    const w = await newFernwood();
    await w.k(skipOrganization);
    await w.say((tx, c) => sendTeam(tx, c, SETUP.override, []));
    const reply = await lastReply(w);
    const d = reply.from === "bike" && reply.status === "done" ? reply.team! : null;
    const by = (n: string) => d!.people.find((p) => p.name === n)!;
    expect(by("Priya Nair").manager).toBe("Dev Kumar");
    expect(by("Dev Kumar").manager).toBe("wade@fernwood.dev");
    expect(leadsTable(d!).leads.map((l) => [l.name, l.reports])).toEqual([
      ["Wade Wilson", 0],
      ["Dev Kumar", 1],
    ]);
  });

  it("a guessed email from the model counts as missing", async () => {
    const w = await newFernwood();
    await w.k(skipOrganization);
    const guessed = { people: [{ name: "Wade Wilson", email: "wade@fernwood.dev", title: "Founder", manager: null, team: null }, { name: "Priya Nair", email: "priya@fernwood.dev", title: "Engineering lead", manager: "wade@fernwood.dev", team: null }], teams: [], problems: [] };
    useProvider({ call: async (req) => ({ model: req.model, text: JSON.stringify(guessed), stop: "done", usage: { tokensIn: 10, tokensOut: 10, cacheRead: 0, cacheWrite: 0 }, ms: 1 }) });
    await w.say((tx, c) => sendTeam(tx, c, "I'm the founder. Priya leads engineering.", []));
    const reply = await lastReply(w);
    const d = reply.from === "bike" && reply.status === "done" ? reply.team! : null;
    expect(d!.people.find((p) => p.name === "Priya Nair")!.email).toBeNull();
    expect(d!.problems).toContain("What is Priya Nair's work email?");
    await w.k(finishSetup);
    expect((await w.k((tx) => tx.select().from(people))).map((p) => p.email)).toEqual(["wade@fernwood.dev"]);
  });

  it("a team file alone is read by the CSV rules, with no prompt 8; other headers are mapped first", async () => {
    const w = await newFernwood();
    await w.k(skipOrganization);
    const csv = await w.upload("tests/files/team.csv");
    await w.say((tx, c) => sendTeam(tx, c, "", [csv]));
    expect(await lastReply(w)).toMatchObject({ status: "done", text: "I found 14 people in team.csv. These are the leads; the other 9 report to them." });
    expect(await w.k((tx) => tx.select().from(aiCalls))).toHaveLength(0);

    const v = await newFernwood();
    await v.k(skipOrganization);
    const other = await v.upload("tests/files/team-other-headers.csv");
    await v.say((tx, c) => sendTeam(tx, c, "", [other]));
    const reply = await lastReply(v);
    const d = reply.from === "bike" && reply.status === "done" ? reply.team! : null;
    expect(d!.people.map((p) => [p.name, p.manager, p.startDate, p.role])).toEqual([
      ["Wade Wilson", null, "2024-01-15", "Founder"],
      ["Priya Nair", "wade@fernwood.dev", "2024-03-01", "Team lead"],
      ["Maya Chen", "priya@fernwood.dev", "2024-06-10", "Member"],
      ["Dev Kumar", "wade@fernwood.dev", "2024-04-08", "Member"],
      ["Lena Ortiz", "wade@fernwood.dev", "2024-07-01", "Finance"],
    ]);
    expect((await v.k((tx) => tx.select().from(aiCalls))).map((c) => c.prompt)).toEqual(["import-mapping"]);
  });

  it("refuses the wrong files, and skipping the team finishes with the admin alone", async () => {
    const w = await newFernwood();
    const csv = await w.upload("tests/files/team.csv");
    await expect(w.k((tx, c) => sendOrganization(tx, c, "", [csv]))).rejects.toThrow("Bike reads PDFs");
    await w.k(skipOrganization);
    const pdf = await w.upload("tests/files/Purchasing policy.pdf");
    await expect(w.k((tx, c) => sendTeam(tx, c, "", [pdf]))).rejects.toThrow("CSV and Excel");
    await w.k(skipTeam);
    expect((await w.k((tx) => tx.select().from(workspaces)))[0]!.setupDoneAt).not.toBeNull();
    expect(await w.k((tx) => tx.select().from(people).where(eq(people.isAdmin, true)))).toHaveLength(1);
  });

  it("is for admins only", async () => {
    const w = await newFernwood();
    const [maya] = await w.k((tx) => tx.insert(people).values({ workspaceId: w.workspaceId, name: "Maya", email: "maya@fernwood.dev" }).returning());
    const asMaya = { workspaceId: w.workspaceId, actor: { id: maya!.id, email: "maya@fernwood.dev" } };
    await expect(w.k((tx) => sendOrganization(tx, asMaya, SETUP.organization, []))).rejects.toThrow("Only admins");
    await expect(w.k((tx) => readSetup(tx, asMaya))).rejects.toThrow("Only admins");
  });
});
