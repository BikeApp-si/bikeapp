import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { aiCalls, jobs } from "@/db/schema";
import { useProvider } from "@/server/ai/gateway";
import { outbox as sent } from "@/server/email/send";
import { addFromGallery } from "@/server/gallery/add";
import { hasModel } from "@/server/kernel/instance-settings";
import { loadSet } from "@/server/kernel/gallery/format";
import { createRow, getRow, listRows, moveStep } from "@/server/kernel/rows";
import { waitingFor } from "@/server/kernel/waiting";
import { runQueued } from "@/server/jobs/run";
import "@/server/jobs/runners";
import { sendOutbox, tick } from "@/server/jobs/tick";
import { kernelWorkspace } from "./kernel";

// O3's Done when: an open Bike with no model (no Anthropic key) adds an app set and runs a week of everyday work:
// time logged and approved into a project's budget, an expense, time off, a new role, the hourly tick each morning
// (date rules, morning emails, the Monday email), the queued jobs and the outbox. Nothing asks the AI: a provider that
// counts stands in, and no AI call is logged.

const set = () => loadSet(path.join(process.cwd(), "gallery/services-firm"));
const APPS = ["clients", "projects", "timesheets", "spend", "onboarding", "hiring", "time_off"];
// Chicago (CDT), the test company's time zone.
const at = (local: string) => new Date(`${local}-05:00`);
const WEEK = ["2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10"]; // Monday to Friday

type K = Awaited<ReturnType<typeof kernelWorkspace>>;
let k: K;
let app: Record<string, string>;
let project: string;
let asked = 0;
let request = "";

beforeAll(async () => {
  process.env.BIKE_MODE = "single";
  vi.stubEnv("AI_PROVIDER", "anthropic");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  useProvider({
    call: async () => {
      asked++;
      throw new Error("Nothing in a no-model week may ask the AI.");
    },
  });
  k = await kernelWorkspace();
  const added = await k.as("ada", (tx, c) => addFromGallery(tx, c, set(), { apps: APPS, slots: { partner: [k.id.ada], operations: [k.id.rita], finance: [k.id.omar], project_managers: [k.id.priya] } }), at("2026-07-03T10:00:00"));
  app = Object.fromEntries(added.apps.map((a) => [a.key, a.id]));
  const client = await k.as("rita", (tx, c) => createRow(tx, c, app.clients!, "clients", { values: { name: "Northwind" } }), at("2026-07-03T10:00:00"));
  project = (await k.as("priya", (tx, c) => createRow(tx, c, app.projects!, "projects", { values: { name: "Website rebuild", client: client.id, budget: 1_000_000 } }), at("2026-07-03T10:00:00"))).id;
  await k.as("priya", (tx, c) => moveStep(tx, c, project, "active"), at("2026-07-03T10:00:00"));
  await k.as("omar", (tx, c) => createRow(tx, c, app.timesheets!, "rates", { values: { person: k.id.maya, from: "2026-01-01", rate: 10_000 } }), at("2026-07-03T10:00:00"));
}, 60_000);

afterAll(() => {
  useProvider(null);
  vi.unstubAllEnvs();
  delete process.env.BIKE_MODE;
});

// One day: the morning tick, the day's work, then the jobs and the outbox, as the worker runs them.
async function day(date: string, work: () => Promise<void>) {
  await tick(at(`${date}T07:05:00`), { workspaceId: k.workspaceId });
  await work();
  await runQueued(k.workspaceId);
  await sendOutbox({ workspaceId: k.workspaceId });
}

describe("a week with no AI model", () => {
  it("has no model", async () => {
    expect(await hasModel()).toBe(false);
  });

  it("runs Monday to Friday and the next Monday, with nothing asking the AI", async () => {
    for (const [i, date] of WEEK.entries()) {
      await day(date, async () => {
        const time = await k.as("maya", (tx, c) => createRow(tx, c, app.timesheets!, "time", { values: { project, date, hours: 8, work: "Design and build" } }), at(`${date}T17:00:00`));
        await k.as("maya", (tx, c) => moveStep(tx, c, time.id, "submitted"), at(`${date}T17:05:00`));
        await k.as("priya", (tx, c) => moveStep(tx, c, time.id, "approved"), at(`${date}T18:00:00`));
        if (i === 0) {
          const expense = await k.as("maya", (tx, c) => createRow(tx, c, app.spend!, "expenses", { values: { what: "Train to the client", amount: 14_000, category: "travel", project, billable: "yes" } }), at(`${date}T12:00:00`));
          await k.as("maya", (tx, c) => moveStep(tx, c, expense.id, "submitted"), at(`${date}T12:05:00`));
        }
        if (i === 1) {
          const [expense] = (await k.as("omar", (tx, c) => waitingFor(tx, c), at(`${date}T09:00:00`))).filter((w) => w.title === "Train to the client");
          expect(expense).toBeTruthy();
          const row = (await k.as("omar", (tx, c) => listRows(tx, c, app.spend!, "expenses"), at(`${date}T09:00:00`))).find((r) => r.data.what === "Train to the client")!;
          await k.as("omar", (tx, c) => moveStep(tx, c, row.id, "approved"), at(`${date}T09:05:00`));
        }
        if (i === 2) request = (await k.as("maya", (tx, c) => createRow(tx, c, app.time_off!, "requests", { values: { type: "vacation", from: "2026-08-17", to: "2026-08-21" } }), at(`${date}T11:00:00`))).id;
        if (i === 3) {
          expect((await k.as("priya", (tx, c) => waitingFor(tx, c), at(`${date}T09:00:00`))).map((w) => [w.title, w.label])).toContainEqual(["Maya Chen", "Approve or decline"]);
          await k.as("priya", (tx, c) => moveStep(tx, c, request, "approved"), at(`${date}T09:05:00`));
        }
        if (i === 4) {
          const role = await k.as("rita", (tx, c) => createRow(tx, c, app.hiring!, "openings", { values: { role: "Designer", hiring_manager: k.id.priya, salary_band: { from: 5_000_000, to: 6_000_000 } } }), at(`${date}T10:00:00`));
          await k.as("rita", (tx, c) => moveStep(tx, c, role.id, "open"), at(`${date}T10:05:00`));
        }
      });
    }
    await day("2026-07-11", async () => undefined);
    await day("2026-07-12", async () => undefined);
    await day("2026-07-13", async () => undefined); // Monday: the admins' weekly email

    // The work all landed: forty hours at €100 and the train ticket in the project's spend.
    expect((await k.as("priya", (tx, c) => getRow(tx, c, project), at("2026-07-13T09:00:00"))).data).toMatchObject({ spent: 414_000, remaining: 586_000 });
    expect((await k.as("maya", (tx, c) => getRow(tx, c, request), at("2026-07-13T09:00:00"))).data.status).toBe("approved");
    // Nothing asked the AI, nothing was logged, and no job failed or waits for a model.
    expect(asked).toBe(0);
    expect(await k.as("ada", (tx) => tx.select().from(aiCalls))).toEqual([]);
    const all = await k.as("ada", (tx) => tx.select({ kind: jobs.kind, status: jobs.status }).from(jobs));
    expect(all.filter((j) => j.status === "failed")).toEqual([]);
    expect(all.filter((j) => j.kind === "ontology")).toEqual([]);
    expect(await k.as("ada", (tx) => tx.select().from(jobs).where(and(eq(jobs.workspaceId, k.workspaceId), eq(jobs.status, "queued"))))).toEqual([]);
    // The emails of an ordinary week went out: what waits on Priya each morning, and the Monday email.
    const mail = sent().filter((m) => m.to.endsWith(`@${k.email("ada").split("@")[1]}`));
    expect(mail.filter((m) => m.to === k.email("priya") && /waits on you/.test(m.subject)).length).toBeGreaterThanOrEqual(1);
    expect(mail.length).toBeGreaterThanOrEqual(3);
  }, 120_000);
});
