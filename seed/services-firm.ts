// G4: Kestrel Partners, a design and software consultancy in Ljubljana that added the professional services set
// (gallery/services-firm) on Jan 5, 2026, with its people filling the set's slots by job title. A few rows for the
// flows: three clients with contracts, three active projects with budgets, everyone's rates, time approved and time
// waiting on a project manager, an expense waiting on finance, a purchase waiting on the partner and an open role.
// The Booking site project is €280 from its budget, so approving Jan's last four hours takes it over. Rows live here,
// never in the set.
import path from "node:path";
import { eq } from "drizzle-orm";
import { people, workspaces } from "@/db/schema";
import type { KernelCtx } from "@/server/kernel/context";
import { addSet, suggestSlots } from "@/server/kernel/gallery/add";
import { loadSet } from "@/server/kernel/gallery/format";
import type { PersonInput } from "@/server/kernel/people";
import { createRow, moveStep } from "@/server/kernel/rows";
import { withWorkspace } from "@/server/kernel/tx";
import { seedWorkspace } from "./index";

const DOMAIN = "kestrel.test";
export const FIRM = { name: "Kestrel Partners", timeZone: "Europe/Ljubljana" };
export const FIRM_ADMIN = { name: "Ana Kovač", email: `ana@${DOMAIN}`, title: "Managing partner", team: "Partners", startDate: "2018-03-01" };
const person = (name: string, user: string, title: string, team: string, manager = "ana"): PersonInput => ({
  name,
  email: `${user}@${DOMAIN}`,
  title,
  team,
  managerEmail: `${manager}@${DOMAIN}`,
  startDate: "2022-02-01",
});
export const FIRM_PEOPLE: PersonInput[] = [
  person("Luka Horvat", "luka", "Operations manager", "Operations"),
  person("Nina Zupan", "nina", "Finance manager", "Operations"),
  person("Marko Novak", "marko", "Project manager", "Delivery"),
  person("Sara Kranjc", "sara", "Account manager", "Delivery"),
  person("Jan Petek", "jan", "Consultant", "Delivery", "marko"),
  person("Eva Golob", "eva", "Designer", "Design", "marko"),
  person("Tim Vidmar", "tim", "Developer", "Engineering", "sara"),
  person("Maja Bizjak", "maja", "Consultant", "Delivery", "sara"),
];

const at = (day: string, time = "10:00") => new Date(`${day}T${time}:00+01:00`);

export async function seedServicesFirm(subdomain: string) {
  const ws = await seedWorkspace({ ...FIRM, subdomain }, FIRM_ADMIN, FIRM_PEOPLE, { created: "2026-01-02T09:00:00Z", imported: "2026-01-02T09:05:00Z" });
  if (!ws.created) return ws;
  const { workspaceId } = ws;
  await withWorkspace({ workspaceId }, async (tx) => {
    // M26: euros, "14 Nov 2026", a year from January.
    await tx.update(workspaces).set({ country: "SI", city: "Ljubljana", currency: "EUR", dateStyle: "dmy", fiscalYearStart: 1 }).where(eq(workspaces.id, workspaceId));
    const all = await tx.select({ id: people.id, email: people.email, title: people.title }).from(people);
    const id = (user: string) => all.find((p) => p.email === `${user}@${DOMAIN}`)!.id;
    const as = (user: string, day: string, time?: string): KernelCtx => ({ workspaceId, actor: { id: id(user), email: `${user}@${DOMAIN}` }, now: at(day, time) });

    const set = loadSet(path.join(process.cwd(), "gallery/services-firm"));
    const added = await addSet(tx, as("ana", "2026-01-05", "09:00"), set, { apps: set.apps, slots: suggestSlots(set, all) });
    const app = Object.fromEntries(added.apps.map((a) => [a.key, a.id]));
    const add = async (user: string, day: string, key: string, sheet: string, values: Record<string, unknown>) => (await createRow(tx, as(user, day), app[key]!, sheet, { values })).id;
    const move = async (user: string, day: string, row: string, ...steps: string[]) => {
      for (const step of steps) await moveStep(tx, as(user, day), row, step);
    };

    // Clients and their contracts, kept by operations.
    const CLIENTS: [name: string, industry: string, owner: string, title: string, kind: string, value: number, start: string][] = [
      ["Alpine Dairy", "Food", "sara", "Brand and packaging, 2026", "retainer", 4_800_000, "2026-01-15"],
      ["Ljubljana Transit", "Transport", "sara", "Ticketing app", "fixed", 6_000_000, "2026-03-01"],
      ["Vrba Hotels", "Hospitality", "marko", "Booking site", "time", 800_000, "2026-09-01"],
    ];
    const client: Record<string, string> = {};
    for (const [name, industry, owner, title, kind, value, start] of CLIENTS) {
      client[name] = await add("luka", "2026-01-12", "clients", "clients", { name, industry, owner: id(owner), status: "active" });
      const contract = await add("luka", start, "clients", "contracts", { client: client[name], title, kind, value, start });
      await move("luka", start, contract, "signed", "active");
    }
    await add("luka", "2026-01-12", "clients", "contacts", { client: client["Alpine Dairy"], name: "Petra Mlakar", role: "Marketing director", email: "petra@alpinedairy.test" });
    await add("luka", "2026-03-01", "clients", "contacts", { client: client["Ljubljana Transit"], name: "Gregor Kos", role: "Head of digital", email: "gregor@lpt.test" });
    await add("luka", "2026-09-01", "clients", "contacts", { client: client["Vrba Hotels"], name: "Irena Vrba", role: "Owner", email: "irena@vrbahotels.test" });

    // Projects, each run by a project manager.
    const PROJECTS: [name: string, client: string, manager: string, kind: string, budget: number, start: string][] = [
      ["Brand refresh", "Alpine Dairy", "marko", "retainer", 2_400_000, "2026-01-19"],
      ["Ticketing app", "Ljubljana Transit", "sara", "fixed", 6_000_000, "2026-03-02"],
      ["Booking site", "Vrba Hotels", "marko", "time", 800_000, "2026-09-07"],
    ];
    const project: Record<string, string> = {};
    for (const [name, c, manager, kind, budget, start] of PROJECTS) {
      project[name] = await add(manager, start, "projects", "projects", { name, client: client[c], manager: id(manager), kind, budget, start });
      await move(manager, start, project[name], "active");
    }

    // Rates an hour, kept by finance; Jan's went up in October.
    const RATES: [user: string, from: string, rate: number][] = [
      ["jan", "2026-01-01", 9_000],
      ["jan", "2026-10-01", 10_000],
      ["eva", "2026-01-01", 8_500],
      ["tim", "2026-01-01", 9_500],
      ["maja", "2026-01-01", 9_000],
      ["marko", "2026-01-01", 11_000],
      ["sara", "2026-01-01", 11_000],
    ];
    for (const [user, from, rate] of RATES) await add("nina", "2026-01-05", "timesheets", "rates", { person: id(user), from, rate });

    // Time: approved by each person's manager, so it counts toward the project's budget.
    type Time = [user: string, project: string, date: string, hours: number, work: string];
    const log = (t: Time) => add(t[0], t[2], "timesheets", "time", { project: project[t[1]], date: t[2], hours: t[3], work: t[4] });
    const MANAGER: Record<string, string> = { jan: "marko", eva: "marko", tim: "sara", maja: "sara", marko: "ana", sara: "ana" };
    const APPROVED: Time[] = [
      ["eva", "Brand refresh", "2026-10-05", 7, "Packaging concepts"],
      ["eva", "Brand refresh", "2026-10-06", 6, "Packaging concepts"],
      ["tim", "Ticketing app", "2026-10-05", 8, "Payments screen"],
      ["maja", "Ticketing app", "2026-10-06", 5, "Workshop with the client"],
      // Booking site: €7,720 of its €8,000 (48 hours of Jan at €100, 24 of Eva at €85, 8 of Marko at €110).
      ["jan", "Booking site", "2026-10-12", 12, "Booking flow"],
      ["jan", "Booking site", "2026-10-13", 12, "Booking flow"],
      ["jan", "Booking site", "2026-10-14", 12, "Booking flow"],
      ["jan", "Booking site", "2026-10-15", 12, "Booking flow"],
      ["eva", "Booking site", "2026-10-12", 8, "Room pages"],
      ["eva", "Booking site", "2026-10-13", 8, "Room pages"],
      ["eva", "Booking site", "2026-10-14", 8, "Room pages"],
      ["marko", "Booking site", "2026-10-15", 8, "Client review"],
    ];
    for (const t of APPROVED) {
      const row = await log(t);
      await move(t[0], t[2], row, "submitted");
      await move(MANAGER[t[0]]!, "2026-10-19", row, "approved");
    }
    // Waiting on Marko: Jan's last four hours on Booking site (€400, which takes it €120 over).
    const waiting = await log(["jan", "Booking site", "2026-10-22", 4, "Launch fixes"]);
    await move("jan", "2026-10-23", waiting, "submitted");
    const evaWaiting = await log(["eva", "Brand refresh", "2026-10-23", 6, "Shelf mock-ups"]);
    await move("eva", "2026-10-23", evaWaiting, "submitted");
    await log(["jan", "Booking site", "2026-10-26", 3, "Handover notes"]); // a draft

    // An expense for a project, waiting on Nina; a purchase waiting on Ana.
    const expense = await add("eva", "2026-10-26", "spend", "expenses", { what: "Print proofs", amount: 18_500, category: "materials", project: project["Brand refresh"], billable: "yes", date: "2026-10-23" });
    await move("eva", "2026-10-26", expense, "submitted");
    await add("tim", "2026-10-26", "spend", "purchases", { what: "Test phones", supplier: "Big Bang", amount: 120_000, project: project["Ticketing app"] });

    // An open role, hired for by Marko.
    const role = await add("luka", "2026-10-19", "hiring", "openings", { role: "Senior designer", team: "design", hiring_manager: id("marko"), salary_band: { from: 4_200_000, to: 5_400_000 }, opens_on: "2026-10-26" });
    await move("luka", "2026-10-19", role, "open");
    await add("luka", "2026-10-26", "hiring", "candidates", { name: "Lea Hribar", opening: role, source: "inbound", email: "lea@hribar.test" });
  });
  return ws;
}
