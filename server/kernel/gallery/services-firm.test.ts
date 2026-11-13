import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { outbox } from "@/db/schema";
import { kernelWorkspace } from "@/tests/kernel";
import { createRow, getRow, listRows, moveStep } from "../rows";
import { runDateRules, systemCtx } from "../date-rules";
import { decide, waitingFor } from "../waiting";
import { addSet, previewSet } from "./add";
import { checkSet } from "./check";
import { loadSet } from "./format";

// G4 · The professional services set (gallery/services-firm), added to a test company and run through a firm's days in
// the kernel: a contract comes up for renewal, time is logged at the rate in force on its day and approved by the
// person's manager into the project's budget, an overrun tells the partner, expenses and purchases wait on finance and
// the partner, a hire starts onboarding, and people see only their own time. Ada is the partner, Rita operations, Omar
// finance, Priya a project manager (and Maya's and Omar's manager); Maya is a consultant.

const set = () => loadSet(path.join(process.cwd(), "gallery/services-firm"));
const APPS = ["clients", "projects", "timesheets", "spend", "onboarding", "hiring", "time_off"];
type K = Awaited<ReturnType<typeof kernelWorkspace>>;
const slots = (k: K) => ({ partner: [k.id.ada], operations: [k.id.rita], finance: [k.id.omar], project_managers: [k.id.priya] });
const at = (d: string) => new Date(`${d}T06:00:00Z`);

describe("the professional services set", () => {
  it("passes the set's check", () => {
    const r = checkSet(set());
    expect(r.ok ? [] : r.problems).toEqual([]);
  });

  it("can't add Timesheets without Projects, or Hiring without Onboarding", async () => {
    const k = await kernelWorkspace();
    const p = await k.as("ada", (tx, c) => previewSet(tx, c, set(), { apps: ["clients", "timesheets", "hiring"], slots: slots(k) }));
    expect(p.problems).toContain("Timesheets needs Projects, so add them together.");
    expect(p.problems).toContain("Hiring needs Onboarding, so add them together.");
  });

  it("names its four slots, and adds no company rules", async () => {
    const k = await kernelWorkspace();
    const p = await k.as("ada", (tx, c) => previewSet(tx, c, set(), { apps: APPS, slots: slots(k) }));
    expect(p.problems).toEqual([]);
    expect(p.slots.map((s) => s.name)).toEqual(["Partner", "Operations", "Finance", "Project managers"]);
    expect((p.alsoChanges ?? []).filter((c) => c.startsWith("Ontology › Company rules"))).toEqual([]);
  });
});

describe("a firm's days", () => {
  let k: K;
  let app: Record<string, string>;
  const ids: Record<string, string> = {};

  const mailTo = (who: "ada" | "rita" | "priya") => k.as("ada", (tx) => tx.select().from(outbox).where(eq(outbox.personId, k.id[who])));
  const waiting = async (who: "ada" | "rita" | "priya" | "omar", day: string) => (await k.as(who, (tx, c) => waitingFor(tx, c), at(day))).map((w) => [w.title, w.label]);
  const project = (day: string) => k.as("priya", (tx, c) => getRow(tx, c, ids.project!), at(day));
  const logTime = (who: "maya" | "omar", date: string, hours: number) =>
    k.as(who, (tx, c) => createRow(tx, c, app.timesheets!, "time", { values: { project: ids.project, date, hours, work: "Design and build" } }), at(date));

  beforeAll(async () => {
    k = await kernelWorkspace();
    const added = await k.as("ada", (tx, c) => addSet(tx, c, set(), { apps: APPS, slots: slots(k) }), at("2026-01-02"));
    app = Object.fromEntries(added.apps.map((a) => [a.key, a.id]));
    ids.client = (await k.as("rita", (tx, c) => createRow(tx, c, app.clients!, "clients", { values: { name: "Northwind" } }), at("2026-01-02"))).id;
    // €10,000 for the project; Maya at €100 an hour, €120 from July.
    ids.project = (
      await k.as("priya", (tx, c) => createRow(tx, c, app.projects!, "projects", { values: { name: "Website rebuild", client: ids.client, budget: 1_000_000 } }), at("2026-01-05"))
    ).id;
    await k.as("priya", (tx, c) => moveStep(tx, c, ids.project!, "active"), at("2026-01-05"));
    for (const [from, rate] of [["2026-01-01", 10_000], ["2026-07-01", 12_000]] as const)
      await k.as("omar", (tx, c) => createRow(tx, c, app.timesheets!, "rates", { values: { person: k.id.maya, from, rate } }), at("2026-01-02"));
  });

  it("60 days before a contract's notice date, it waits on the client's account owner, and the partner hears 30 days on", async () => {
    // Renews a year after Jan 1, 2026, with 30 days' notice: Dec 2, 2026.
    const contract = await k.as("rita", (tx, c) => createRow(tx, c, app.clients!, "contracts", { values: { client: ids.client, title: "Retainer 2026", kind: "retainer", value: 6_000_000, start: "2026-01-01" } }), at("2026-01-02"));
    expect(contract.data).toMatchObject({ renews_on: "2027-01-01", notice_date: "2026-12-02" });
    for (const step of ["signed", "active"]) await k.as("rita", (tx, c) => moveStep(tx, c, contract.id, step), at("2026-01-02"));
    const tick = (day: string) => k.as("ada", (tx) => runDateRules(tx, systemCtx(k.workspaceId, at(day)), { capabilityId: app.clients! }));
    await tick("2026-10-03");
    expect((await k.as("rita", (tx, c) => getRow(tx, c, contract.id), at("2026-10-03"))).data.status).toBe("renewal_due");
    expect(await waiting("rita", "2026-10-03")).toContainEqual(["Retainer 2026", "Decide on the renewal"]);
    const before = (await mailTo("ada")).length;
    await tick("2026-11-02");
    expect((await mailTo("ada")).length).toBe(before + 1);
  });

  it("time is valued at the rate in force on its day; the manager approves it into what the project has spent", async () => {
    const june = await logTime("maya", "2026-06-30", 8);
    const july = await logTime("maya", "2026-07-01", 8);
    const read = (id: string) => k.as("maya", (tx, c) => getRow(tx, c, id), at("2026-07-03")).then((r) => [r.data.rate, r.data.value]);
    expect(await read(june.id)).toEqual([10_000, 80_000]);
    expect(await read(july.id)).toEqual([12_000, 96_000]);
    for (const t of [june, july]) await k.as("maya", (tx, c) => moveStep(tx, c, t.id, "submitted"), at("2026-07-03"));
    // Maya can't approve her own time; Priya, her manager, is asked.
    await expect(k.as("maya", (tx, c) => moveStep(tx, c, june.id, "approved"), at("2026-07-03"))).rejects.toThrow();
    expect((await waiting("priya", "2026-07-03")).filter(([, l]) => l === "Approve or reject")).toHaveLength(2);
    for (const t of [june, july]) await k.as("priya", (tx, c) => moveStep(tx, c, t.id, "approved"), at("2026-07-03"));
    expect((await project("2026-07-03")).data).toMatchObject({ spent: 176_000, remaining: 824_000 });
    expect(await waiting("priya", "2026-07-03")).not.toContainEqual(expect.arrayContaining(["Approve or reject"]));
  });

  it("time without a rate is refused, and each person sees only their own time", async () => {
    await expect(logTime("omar", "2026-07-02", 4)).rejects.toThrow(/has a rate on this date/);
    await k.as("omar", (tx, c) => createRow(tx, c, app.timesheets!, "rates", { values: { person: k.id.omar, from: "2026-01-01", rate: 9_000 } }), at("2026-07-02"));
    await logTime("omar", "2026-07-02", 4);
    const who = async (name: "maya" | "omar" | "priya") => new Set((await k.as(name, (tx, c) => listRows(tx, c, app.timesheets!, "time"), at("2026-07-02"))).map((r) => r.data.person));
    expect(await who("maya")).toEqual(new Set([k.id.maya]));
    expect(await who("priya")).toEqual(new Set([k.id.maya, k.id.omar]));
    // Rates are finance's: Maya sees none of them.
    expect(await k.as("maya", (tx, c) => listRows(tx, c, app.timesheets!, "rates"), at("2026-07-02"))).toEqual([]);
  });

  it("an approved project expense counts toward the budget; finance approves it", async () => {
    const expense = await k.as("maya", (tx, c) => createRow(tx, c, app.spend!, "expenses", { values: { what: "Train to the client", amount: 14_000, category: "travel", project: ids.project, billable: "yes" } }), at("2026-07-06"));
    expect(expense.data.status).toBe("needs_receipt");
    await k.as("maya", (tx, c) => moveStep(tx, c, expense.id, "submitted"), at("2026-07-06"));
    expect(await waiting("omar", "2026-07-06")).toContainEqual(["Train to the client", "Approve or reject"]);
    await k.as("omar", (tx, c) => moveStep(tx, c, expense.id, "approved"), at("2026-07-06"));
    expect((await project("2026-07-06")).data).toMatchObject({ spent: 190_000, remaining: 810_000 });
  });

  it("a purchase waits on the partner", async () => {
    const p = await k.as("maya", (tx, c) => createRow(tx, c, app.spend!, "purchases", { values: { what: "Stock photos", amount: 30_000, project: ids.project } }), at("2026-07-06"));
    expect(await waiting("ada", "2026-07-06")).toContainEqual(["Stock photos", "Approve or reject"]);
    await k.as("ada", (tx, c) => moveStep(tx, c, p.id, "approved"), at("2026-07-07"));
    expect((await project("2026-07-07")).data.spent).toBe(220_000);
  });

  it("the partner hears once when a project goes over its budget", async () => {
    const before = (await mailTo("ada")).length;
    // 70 hours at €120 over three days takes €2,200 spent to €10,600, over the €10,000 budget.
    for (const [date, hours] of [["2026-07-08", 24], ["2026-07-09", 24], ["2026-07-10", 22]] as const) {
      const t = await logTime("maya", date, hours);
      await k.as("maya", (tx, c) => moveStep(tx, c, t.id, "submitted"), at("2026-07-10"));
      await k.as("priya", (tx, c) => moveStep(tx, c, t.id, "approved"), at("2026-07-10"));
    }
    expect((await project("2026-07-10")).data).toMatchObject({ spent: 1_060_000, remaining: -60_000 });
    expect((await mailTo("ada")).length).toBe(before + 1);
    // Further time on a project already over doesn't tell the partner again.
    const more = await logTime("maya", "2026-07-13", 2);
    await k.as("maya", (tx, c) => moveStep(tx, c, more.id, "submitted"), at("2026-07-13"));
    await k.as("priya", (tx, c) => moveStep(tx, c, more.id, "approved"), at("2026-07-13"));
    expect((await mailTo("ada")).length).toBe(before + 1);
  });

  it("an offer above the band waits on the partner; a hire starts an onboarding plan with two tasks", async () => {
    const role = await k.as("rita", (tx, c) => createRow(tx, c, app.hiring!, "openings", { values: { role: "Designer", hiring_manager: k.id.priya, salary_band: { from: 5_000_000, to: 6_000_000 } } }), at("2026-08-03"));
    await k.as("rita", (tx, c) => moveStep(tx, c, role.id, "open"), at("2026-08-03"));
    const cand = await k.as("rita", (tx, c) => createRow(tx, c, app.hiring!, "candidates", { values: { name: "Lea Novak", opening: role.id, offer: 6_500_000, start_date: "2026-09-01" } }), at("2026-08-03"));
    for (const step of ["screen", "interview", "offer"]) await k.as("rita", (tx, c) => moveStep(tx, c, cand.id, step), at("2026-08-10"));
    expect(await waiting("ada", "2026-08-10")).toContainEqual(["Lea Novak", "Approve the offer"]);
    const offer = (await k.as("ada", (tx, c) => waitingFor(tx, c), at("2026-08-11"))).find((w) => w.label === "Approve the offer")!;
    await k.as("ada", (tx, c) => decide(tx, c, offer.waitId!, "approve"), at("2026-08-11"));
    expect(await waiting("priya", "2026-08-11")).toContainEqual(["Lea Novak", "Send the offer"]);
    await k.as("rita", (tx, c) => moveStep(tx, c, cand.id, "hired"), at("2026-08-12"));
    const plans = await k.as("rita", (tx, c) => listRows(tx, c, app.onboarding!, "plans"), at("2026-08-12"));
    expect(plans.map((p) => p.data)).toEqual([expect.objectContaining({ name: "Lea Novak", start_date: "2026-09-01", manager: k.id.priya })]);
    const tasks = await k.as("priya", (tx, c) => listRows(tx, c, app.onboarding!, "tasks"), at("2026-08-12"));
    expect(tasks.map((t) => t.data.task)).toEqual(["Welcome and first-week plan", "Laptop and accounts ready"]);
    expect((await k.as("rita", (tx, c) => getRow(tx, c, role.id), at("2026-08-12"))).data.status).toBe("filled");
  });

  it("time off waits on the person's manager", async () => {
    await k.as("maya", (tx, c) => createRow(tx, c, app.time_off!, "requests", { values: { type: "vacation", from: "2026-08-17", to: "2026-08-21" } }), at("2026-08-03"));
    expect(await waiting("priya", "2026-08-03")).toContainEqual(["Maya Chen", "Approve or decline"]);
  });
});
