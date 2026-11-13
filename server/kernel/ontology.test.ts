import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditEntries, people } from "@/db/schema";
import { seedWorkspace } from "@/seed";
import { seedCapabilities } from "@/seed/capabilities";
import { FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES } from "@/seed/fernwood";
import type { KernelCtx } from "./context";
import { checkOntology, hashOf, listOntologyVersions, ontologyInput, ontologyLine, ontologyText, ontologyView, pastInput, readOf, readOntology, readOntologyVersion, saveOntology, versionWhat, type OntologyInput, type OntologyRead, type OntologyWritten } from "./ontology";
import { withWorkspace, type Tx } from "./tx";

// The Ontology's kernel side on Fernwood as the screens show it (4e): what prompt 6 is given, the check of
// what it writes, the one stored version, and the breakdown the page shows with no AI.

let ws: string;
const ids = new Map<string, string>();
const as = <T>(n: string, fn: (tx: Tx, c: KernelCtx) => Promise<T>) =>
  withWorkspace({ workspaceId: ws, personId: ids.get(n) }, (tx) => fn(tx, { workspaceId: ws, actor: { id: ids.get(n)!, email: `${n}@fernwood.dev` } }));
let input: OntologyInput;

beforeAll(async () => {
  ws = (await seedWorkspace({ subdomain: `on${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
  await seedCapabilities(ws);
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    for (const p of await tx.select({ id: people.id, email: people.email }).from(people)) ids.set(p.email.split("@")[0]!, p.id);
  });
  input = await as("wade", ontologyInput);
}, 60_000);

const written = (): OntologyWritten => ({
  intro: "Fernwood is a 14-person software company.",
  paragraphs: ["People holds 14 employees across 5 teams."],
  sentences: Object.fromEntries(input.capabilities.map((c) => [c.name, `${c.name} holds its rows.`])),
  phrases: Object.fromEntries(input.connections.map((c) => [c.key, "work moves on"])),
  worth: [],
});

describe("what prompt 6 is given", () => {
  it("each app with its text, counts and owner, the connections between them, and the stats", () => {
    expect(input.company).toMatchObject({ name: "Fernwood Labs", people: 14, teams: 5 });
    expect(input.capabilities.map((c) => c.name)).toEqual(["Hiring", "Onboarding", "Time off", "Spend", "Tools and budgets", "Customer contracts"]);
    const spend = input.capabilities.find((c) => c.name === "Spend")!;
    expect(spend.owner).toBe("Lena");
    expect(spend.text).toContain("Who can see and do what:");
    expect(input.connections.map((c) => c.key)).toContain("Hiring > Onboarding");
    // A gap is a column some rows left empty; none is reported for a column empty on every row.
    for (const g of input.stats.gaps) expect(g.empty).toBeLessThan(input.capabilities.find((c) => c.name === g.capability)!.rows);
    // Two people were imported with a manager who isn't in People (7f).
    expect(input.stats.withoutManager.sort()).toEqual(["Aisha Khan", "Leo Grant"].sort());
  });

  it("is the same every time, so its hash says when it changed", async () => {
    expect(hashOf(await as("wade", ontologyInput))).toBe(hashOf(input));
  });

  it("only an admin may ask", async () => {
    await expect(as("maya", ontologyInput)).rejects.toThrow();
  });
});

describe("the check of what prompt 6 wrote", () => {
  it("accepts a sentence per app, phrases for known connections, and only numbers it was given", () => {
    expect(checkOntology(written(), input)).toEqual([]);
  });

  it("refuses a missing or unknown app, an unknown connection, too many items, and an invented number", () => {
    const w = written();
    delete w.sentences.Spend;
    w.sentences.Payroll = "Pays people.";
    w.phrases["x>y"] = "nothing";
    w.worth = ["a", "b", "c", "d"];
    w.paragraphs.push("Purchases over $7,777 go to Krishna.");
    const problems = checkOntology(w, input).join("\n");
    expect(problems).toContain("Write one sentence for Spend.");
    expect(problems).toContain('"Payroll" isn\'t an app');
    expect(problems).toContain('"x>y" isn\'t one of the connections');
    expect(problems).toContain("At most 3");
    expect(problems).toContain("7777 isn't a number");
  });
});

describe("the stored version and the page", () => {
  it("is one current version, numbered, with an Audit entry each time", async () => {
    expect(await as("wade", (tx) => readOntology(tx))).toBeNull();
    expect(await as("wade", (tx, c) => saveOntology(tx, c, hashOf(input), written(), readOf(input)))).toBe(1);
    expect(await as("wade", (tx, c) => saveOntology(tx, c, "other", written(), readOf(input)))).toBe(2);
    expect((await as("wade", (tx) => readOntology(tx)))!.version).toBe(2);
    const entries = await as("wade", (tx) => tx.select().from(auditEntries).where(eq(auditEntries.event, "ontology.written")));
    expect(entries.map((e) => e.details)).toEqual([{ version: 1 }, { version: 2 }]);
    await expect(as("maya", (tx, c) => saveOntology(tx, c, "x", written(), []))).rejects.toThrow();
  });

  it("reads from the files where nothing was written: each app's sheets, each connection's rule", () => {
    const view = ontologyView(input, null);
    expect(view.intro).toBeNull();
    const hiring = view.each.find((c) => c.name === "Hiring")!;
    expect(hiring.meta).toBe("3 sheets · 2 step flows · owned by Wade");
    expect(hiring.sentence).toMatch(/^[A-Z][a-z]+(, [a-z ]+)* and [a-z ]+\.$/);
    expect(view.connections[0]!.phrase).toBe(input.connections[0]!.reading);
  });

  it("says when it was written, and downloads as text", () => {
    const view = ontologyView(input, { version: 3, inputHash: "h", written: written(), writtenAt: new Date("2026-10-27T14:00:00Z") });
    expect(ontologyLine(view, new Date("2026-10-27T18:00:00Z"), "America/Chicago")).toBe("Written by Bike from the setup of your 6 apps · version 3 · regenerated today, 9:00 am");
    expect(ontologyLine(view, new Date("2026-10-29T18:00:00Z"), "America/Chicago")).toContain("regenerated Oct 27, 9:00 am");
    const text = ontologyText(view);
    expect(text.split("\n")[0]).toBe("How Fernwood Labs runs");
    expect(text).toContain("Each app in a sentence");
    expect(text).toContain("Hiring: Hiring holds its rows.");
  });
});

describe("versions (M34)", () => {
  const R = (name: string, version: number, id = name): OntologyRead => ({ id, name, version });

  it("says in fixed words what each version was written after", () => {
    const five = [R("Hiring", 2), R("Onboarding", 1), R("Time off", 1), R("Spend", 1), R("Tools and budgets", 1)];
    const six = [...five, R("Customer contracts", 1)];
    expect(versionWhat(1, five, null, "Wade")).toBe("First written, from 5 apps.");
    expect(versionWhat(2, six, five, null)).toBe("Written after Customer contracts was added. 6 apps.");
    const changed = six.map((r) => (r.name === "Hiring" || r.name === "Customer contracts" ? { ...r, version: r.version + 2 } : r));
    expect(versionWhat(3, changed, six, "Wade")).toBe("Written after changes to Hiring and Customer contracts. Regenerated by Wade.");
    expect(versionWhat(4, five, six, null)).toBe("Written after Customer contracts was removed. 5 apps.");
    expect(versionWhat(5, six, six, "Lena")).toBe("Written again; no app had changed. Regenerated by Lena.");
    // A rename is a change; added, removed and changed read together.
    expect(versionWhat(6, [R("Hires", 2, "Hiring"), R("Payroll", 1)], [R("Hiring", 2), R("Spend", 1)], null)).toBe(
      "Written after Payroll was added, Spend was removed and changes to Hires. 2 apps.",
    );
    // The version before wasn't kept (written before M34).
    expect(versionWhat(3, six, null, "Wade")).toBe("Written from 6 apps. Regenerated by Wade.");
  });

  it("keeps every version, newest first, each with what it read; old texts stay as they were written", async () => {
    // The two saved above, then a third that reads five apps and says something else.
    const five = readOf(input).filter((r) => r.name !== "Customer contracts");
    const third = { ...written(), intro: "Fernwood runs five apps." };
    expect(await as("wade", (tx, c) => saveOntology(tx, c, "third", third, five))).toBe(3);
    const list = await as("wade", (tx, c) => listOntologyVersions(tx, c));
    expect(list.map((v) => [v.version, v.apps, v.what])).toEqual([
      [3, 5, "Written after Customer contracts was removed. 5 apps. Regenerated by Wade."],
      [2, 6, "Written again; no app had changed. Regenerated by Wade."],
      [1, 6, "First written, from 6 apps."],
    ]);
    const v1 = await as("wade", (tx, c) => readOntologyVersion(tx, c, 1));
    expect(v1!.written.intro).toBe("Fernwood is a 14-person software company.");
    expect(v1!.read).toEqual(readOf(input));
    expect((await as("wade", (tx, c) => readOntologyVersion(tx, c, 3)))!.written.intro).toBe("Fernwood runs five apps.");
    expect(await as("wade", (tx, c) => readOntologyVersion(tx, c, 9))).toBeNull();
    expect(await as("wade", (tx, c) => readOntologyVersion(tx, c, 0))).toBeNull();
  });

  it("shows a past version's apps from their files then, not today's", async () => {
    const five = readOf(input).filter((r) => r.name !== "Customer contracts");
    const past = await as("wade", (tx, c) => pastInput(tx, c, five));
    expect(past.capabilities.map((c) => c.name)).toEqual(["Hiring", "Onboarding", "Time off", "Spend", "Tools and budgets"]);
    const view = ontologyView({ ...input, ...past }, (await as("wade", (tx, c) => readOntologyVersion(tx, c, 3)))!);
    expect(view.each.find((c) => c.name === "Hiring")!.meta).toBe("3 sheets · 2 step flows · owned by Wade");
    expect(view.each.map((c) => c.name)).not.toContain("Customer contracts");
    expect(view.connections.map((c) => `${c.from} > ${c.to}`)).toEqual(input.connections.filter((c) => c.to !== "Customer contracts" && c.from !== "Customer contracts").map((c) => c.key));
    expect(ontologyLine({ ...view, capabilities: 5 }, new Date("2026-10-29T18:00:00Z"), "America/Chicago", undefined, true)).toMatch(/^Written by Bike from the setup of your 5 apps · version 3 · (today|[A-Z][a-z]{2} \d+), \d+:\d\d [ap]m$/);
  });

  it("only admins read them; versions are never changed or removed", async () => {
    await expect(as("maya", (tx, c) => listOntologyVersions(tx, c))).rejects.toThrow();
    await expect(as("maya", (tx, c) => readOntologyVersion(tx, c, 1))).rejects.toThrow();
    await expect(as("maya", (tx, c) => pastInput(tx, c, readOf(input)))).rejects.toThrow();
    const { ontologyVersions } = await import("@/db/schema");
    await expect(as("wade", (tx) => tx.update(ontologyVersions).set({ inputHash: "x" }))).rejects.toThrow();
    await expect(as("wade", (tx) => tx.delete(ontologyVersions))).rejects.toThrow();
  });
});
