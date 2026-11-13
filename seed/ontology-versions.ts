import { eq } from "drizzle-orm";
import { people } from "@/db/schema";
import { coherenceHash, saveCoherence } from "@/server/kernel/coherence";
import { hashOf, ontologyInput, readOf, saveOntology, type OntologyRead, type OntologyWritten } from "@/server/kernel/ontology";
import { withWorkspace } from "@/server/kernel/tx";
import { workspaceBySubdomain } from "@/server/kernel/workspaces";
import { TODAY } from "./capabilities/seeder";

// M34 on a copy: three Ontology versions as m34-b lists them, written without the AI. Version 1 (Oct 14) read five
// apps, before Customer contracts; version 2 (Oct 21) read six, Hiring and Customer contracts a version back;
// version 3 (today, 9:00 am) reads them as they are, so the page is current and asks for nothing.

const PEOPLE = "People is the single source of truth for the organisation: 14 employees across 5 teams, each with a reporting line. Every app uses it to decide who owns a piece of work and who can see it.";
const SPEND = "Spend records expenses and purchases as they move from Submitted to Paid; each person sees their own, and Lena sees all of them. Time off holds requests, balances and holidays.";
const SENTENCES: Record<string, string> = {
  Hiring: "Openings, candidates and interviews. Priya and Dev move their candidates from Applied to Hired; anyone can refer a candidate.",
  Onboarding: "A first-week plan for every new starter, with tasks for IT, the manager and a buddy.",
  "Time off": "Requests, balances and holidays. Each person sees their own; managers see their team.",
  Spend: "Expenses and purchases from Submitted to Paid. Each person sees their own; Lena sees all.",
  "Tools and budgets": "Every software seat and vendor budget, with renewal dates.",
  "Customer contracts": "Contracts from Draft to Renewed or Ended. Owners see their own; Wade and Krishna see all.",
};

function written(apps: string[], paragraphs: string[], first = false): OntologyWritten {
  const lower = apps.map((a) => a.toLowerCase());
  return {
    intro: `Fernwood is a 14-person software company. It runs ${apps.length} apps on Bike: ${lower.slice(0, -1).join(", ")} and ${lower.at(-1)}.`,
    paragraphs,
    sentences: Object.fromEntries(apps.map((a) => [a, first && a === "Hiring" ? "Openings and candidates. Priya and Dev move their candidates from Applied to Hired." : (SENTENCES[a] ?? `${a}.`)])),
    phrases: { "Hiring > Onboarding": "when someone is hired, their first week is planned" },
    worth: [],
  };
}

export async function seedOntologyVersions(subdomain: string) {
  const ws = await workspaceBySubdomain(subdomain);
  if (!ws) return;
  await withWorkspace({ workspaceId: ws.id }, async (tx) => {
    const [wade] = await tx.select({ id: people.id }).from(people).where(eq(people.email, "wade@fernwood.dev"));
    const at = (iso: string) => ({ workspaceId: ws.id, actor: { id: wade!.id, email: "wade@fernwood.dev" }, now: new Date(iso) });
    const input = await ontologyInput(tx, at(`${TODAY}T14:00:00Z`));
    const now = readOf(input);
    const back = (r: OntologyRead): OntologyRead => (r.name === "Hiring" || r.name === "Customer contracts" ? { ...r, version: Math.max(1, r.version - 1) } : r);
    const six = now.map(back);
    const five = six.filter((r) => r.name !== "Customer contracts");
    const names = (rs: OntologyRead[]) => rs.map((r) => r.name);
    const hiring = "The employee lifecycle starts in Hiring, which holds openings and candidates. When a candidate is marked Hired, Onboarding starts a first-week plan for them, with tasks for IT, the manager and a buddy.";
    const contracts = "On the revenue side, Customer contracts tracks customer agreements from Draft to Renewed or Ended. Account owners see only their own contracts; Wade and Krishna see every one.";
    await saveOntology(tx, at("2026-10-14T21:10:00Z"), "seed-1", written(names(five), [PEOPLE, hiring, SPEND], true), five);
    await saveOntology(tx, at("2026-10-21T16:45:00Z"), "seed-2", written(names(six), [PEOPLE, hiring, SPEND, contracts]), six);
    const interviews = hiring.replace("openings and candidates", "openings, candidates and interviews");
    await saveOntology(tx, at(`${TODAY}T14:00:00Z`), hashOf(input), written(names(now), [PEOPLE, interviews, SPEND, contracts]), now);
    await saveCoherence(tx, at(`${TODAY}T14:00:00Z`), coherenceHash(input), []);
  });
}
