import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { people } from "@/db/schema";
import { useProvider } from "@/server/ai/gateway";
import type { OntologyOutput } from "@/server/ai/prompts/ontology-writer@2";
import { seedWorkspace } from "@/seed";
import { seedCapabilities } from "@/seed/capabilities";
import { FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES } from "@/seed/fernwood";
import { ontologyInput, readOntology } from "@/server/kernel/ontology";
import { withWorkspace } from "@/server/kernel/tx";
import { due, ONTOLOGY_EVERY_MS, writeOntology } from "./write";

// Writing the Ontology with prompt 6 (a stand-in here): once when it is out of date, at most every 10
// minutes, and never with an answer the kernel refuses.

let ws: string;
let wade: { id: string; email: string };
let answer: () => OntologyOutput;
let calls = 0;

beforeAll(async () => {
  ws = (await seedWorkspace({ subdomain: `ow${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
  await seedCapabilities(ws);
  const [u] = await withWorkspace({ workspaceId: ws }, (tx) => tx.select({ id: people.id, email: people.email }).from(people).where(eq(people.email, "wade@fernwood.dev")));
  wade = { id: u!.id, email: u!.email };
  const input = await withWorkspace({ workspaceId: ws, personId: wade.id }, (tx) => ontologyInput(tx, { workspaceId: ws, actor: wade }));
  answer = () => ({
    intro: "Fernwood is a 14-person software company.",
    paragraphs: ["People holds 14 employees across 5 teams."],
    sentences: input.capabilities.map((c) => ({ capability: c.name, sentence: `${c.name} holds its rows.` })),
    phrases: input.connections.map((c) => ({ connection: c.key, phrase: "work moves on" })),
    worth: [],
  });
  useProvider({
    call: async () => {
      calls++;
      return { model: "claude-opus-5-5", text: JSON.stringify(answer()), stop: "done", usage: { tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 }, ms: 1 };
    },
  });
}, 60_000);
afterAll(() => useProvider(null));

const job = () => ({ workspaceId: ws, person: wade });
const stored = () => withWorkspace({ workspaceId: ws, personId: wade.id }, (tx) => readOntology(tx));

describe("writing the Ontology", () => {
  it("is due when there is none, or when its inputs changed at least 10 minutes after the last", () => {
    const at = new Date("2026-10-27T15:00:00Z");
    expect(due(null, "h")).toBe(true);
    expect(due({ inputHash: "h", writtenAt: at }, "h", new Date(at.getTime() + ONTOLOGY_EVERY_MS))).toBe(false);
    expect(due({ inputHash: "h", writtenAt: at }, "new", new Date(at.getTime() + ONTOLOGY_EVERY_MS - 1))).toBe(false);
    expect(due({ inputHash: "h", writtenAt: at }, "new", new Date(at.getTime() + ONTOLOGY_EVERY_MS))).toBe(true);
  });

  it("writes once, then not again while nothing changed", async () => {
    expect(await writeOntology(job())).toBe(true);
    expect((await stored())!.version).toBe(1);
    const before = calls;
    expect(await writeOntology(job())).toBe(false);
    expect(calls).toBe(before);
  });

  it("keeps the last version when the answer doesn't pass the kernel's check", async () => {
    const good = answer;
    answer = () => ({ ...good(), paragraphs: ["Purchases over $7,777 go to Krishna."] });
    // Out of date: as if its inputs had changed long ago.
    await withWorkspace({ workspaceId: ws, personId: wade.id }, async (tx) => {
      const { ontologies } = await import("@/db/schema");
      await tx.update(ontologies).set({ inputHash: "old", writtenAt: new Date("2026-01-01T00:00:00Z") });
    });
    expect(await writeOntology(job())).toBe(false);
    expect((await stored())!.written.paragraphs).toEqual(["People holds 14 employees across 5 teams."]);
    answer = good;
  });
});
