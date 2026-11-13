import { beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, isNull } from "drizzle-orm";
import { auditEntries, ruleRuns, waits } from "@/db/schema";
import { kernelWorkspace } from "@/tests/kernel";
import { saveVersion } from "./capabilities";
import { runDateRules, systemCtx } from "./date-rules";
import type { CapabilityFile, Rule } from "./schema/file";
import { getRow, importRows } from "./rows";

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let cap: string;
// 06:00 in Chicago on a given day.
const six = (day: string) => new Date(`${day}T11:00:00Z`);

const REMIND: Rule = {
  id: "remind",
  text: "60 days before the notice date, it waits on its owner.",
  reading: { when: "w", then: "t" },
  trigger: { kind: "date_reached", sheet: "contracts", date: "notice_date", offsetDays: -60 },
  actions: [{ kind: "ask_person", column: "owner", step: "due", label: "Decide on the renewal" }],
  enabled: true,
};
const INTERVIEW: Rule = {
  id: "scorecard",
  text: "On the interview day, if there's no score, it waits on the interviewer.",
  reading: { when: "w", then: "t" },
  trigger: { kind: "date_reached", sheet: "contracts", date: "call", offsetDays: 0 },
  condition: { op: "empty", args: [{ col: "score" }] },
  actions: [{ kind: "ask_person", column: "owner", until: "score", label: "Your scorecard" }],
  enabled: true,
};

const file = (rules: Rule[]): CapabilityFile => ({
  name: "Contracts",
  icon: "file",
  sheets: [
    {
      id: "contracts",
      name: "Contracts",
      kind: "list",
      titleColumn: "customer",
      columns: [
        { id: "customer", name: "Customer", type: "text", required: true },
        { id: "renews_on", name: "Renews on", type: "date" },
        { id: "notice", name: "Notice", type: "days" },
        { id: "notice_date", name: "Notice date", type: "computed", result: "date", expr: { op: "date_add", args: [{ col: "renews_on" }, { op: "sub", args: [0, { col: "notice" }] }, "days"] } },
        { id: "owner", name: "Owner", type: "person" },
        { id: "call", name: "Call", type: "datetime" },
        { id: "score", name: "Score", type: "number" },
        { id: "status", name: "Status", type: "step" },
      ],
      steps: [{ id: "active", name: "Active", start: true }, { id: "due", name: "Renewal due" }, { id: "renewed", name: "Renewed", end: "final" }],
    },
  ],
  roles: [{ id: "all", name: "All", members: { kind: "everyone" }, can: ["see", "add"], scope: "all" }],
  rules,
  later: [],
});

const tick = (day: string) => k.as("ada", (tx) => runDateRules(tx, systemCtx(k.workspaceId, six(day))));
const add = (values: Record<string, unknown>, at: string) =>
  k.as("ada", (tx, c) => importRows(tx, c, cap, "contracts", [{ values: { status: "active", ...values } }], { source: "c.csv", at: new Date(at) })).then((ids) => ids[0]!);
const stepOf = async (id: string) => (await k.as("ada", (tx, c) => getRow(tx, c, id))).stepId;

beforeAll(async () => {
  k = await kernelWorkspace();
  // The rule is saved on Aug 12; the contracts come in on Oct 21.
  cap = await k.as("ada", (tx, c) => import("./capabilities").then((m) => m.createCapability(tx, c, file([REMIND, INTERVIEW]), { source: "build", at: new Date("2026-08-12T16:00:00Z") }))).then((r) => r.id);
});

describe("date rules", () => {
  it("catch up on dates passed since the rule was saved, on the first run after the row exists; older dates never fire", async () => {
    // Orbit: notice date Dec 10, so its date is Oct 11. Pinecone: notice date Oct 4, so Aug 5, before the save.
    const orbit = await add({ customer: "Orbit Health", renews_on: "2027-01-09", notice: 30, owner: k.id.rita }, "2026-10-21T16:02:00Z");
    const pinecone = await add({ customer: "Pinecone Labs", renews_on: "2026-12-03", notice: 60, owner: k.id.rita }, "2026-10-21T16:02:00Z");
    expect(await tick("2026-10-22")).toEqual({ ran: 1 });
    expect(await stepOf(orbit)).toBe("due");
    expect(await stepOf(pinecone)).toBe("active");
    const [run] = await k.as("ada", (tx) => tx.select().from(ruleRuns).where(eq(ruleRuns.rowId, orbit)));
    expect(run).toMatchObject({ ruleId: "remind", onDate: "2026-10-11", ranAt: six("2026-10-22") });
    const [entry] = await k.as("ada", (tx) => tx.select().from(auditEntries).where(and(eq(auditEntries.who, "rule:remind"), eq(auditEntries.event, "rule.ran"))));
    expect(entry).toMatchObject({ at: six("2026-10-22"), details: { sheet: "Contracts", row: "Orbit Health", did: "moved Active → Renewal due; asked Rita Gomez" } });
  });

  it("runs once per row and date, so running the same day again changes nothing", async () => {
    expect(await tick("2026-10-22")).toEqual({ ran: 0 });
    expect(await tick("2026-10-27")).toEqual({ ran: 0 });
  });

  it("a date and time counts on its day in the workspace's time zone; the run is logged even when the condition fails", async () => {
    // 01:00 UTC on Oct 28 is Oct 27 in Chicago.
    const done = await add({ customer: "Kova", owner: k.id.omar, call: "2026-10-28T01:00:00Z", score: 3 }, "2026-10-26T12:00:00Z");
    const open = await add({ customer: "Tom Weiss", owner: k.id.priya, call: "2026-10-28T01:00:00Z" }, "2026-10-26T12:00:00Z");
    expect(await tick("2026-10-26")).toEqual({ ran: 0 });
    expect(await tick("2026-10-27")).toEqual({ ran: 2 });
    const asked = await k.as("ada", (tx) => tx.select().from(waits).where(and(eq(waits.ruleId, "scorecard"), isNull(waits.clearedAt))).orderBy(asc(waits.createdAt)));
    expect(asked.map((w) => [w.rowId, w.personId, w.label, w.stepId])).toEqual([[open, k.id.priya, "Your scorecard", null]]);
    expect(await k.as("ada", (tx) => tx.select().from(ruleRuns).where(eq(ruleRuns.rowId, done)))).toHaveLength(1);
  });

  it("counts from the version that added the rule, not a later one that kept it", async () => {
    // A new version on Oct 25 still has the rule: the rule's save stays Aug 12.
    await k.as("ada", (tx, c) => saveVersion(tx, c, cap, file([REMIND, INTERVIEW]), { source: "customize", event: "customize.saved", at: new Date("2026-10-25T10:00:00Z") }));
    const brightline = await add({ customer: "Brightline", renews_on: "2027-02-02", notice: 90, owner: k.id.rita }, "2026-10-26T12:00:00Z");
    expect(await tick("2026-10-28")).toEqual({ ran: 1 });
    expect(await stepOf(brightline)).toBe("due");
  });

  it("a rule moved earlier (60 → 90 days) catches up a row whose new date has passed, once; rows already reminded for the same notice date aren't reminded again", async () => {
    // Lumen's notice date is Jan 16, 75 days after Nov 2: the 60-day date (Nov 17) hasn't come, the 90-day one (Oct 18) has.
    const lumen = await add({ customer: "Lumen Retail", renews_on: "2027-02-15", notice: 30, owner: k.id.rita }, "2026-11-01T12:00:00Z");
    expect(await tick("2026-11-02")).toEqual({ ran: 0 });
    const earlier = { ...REMIND, trigger: { ...REMIND.trigger, offsetDays: -90 } };
    await k.as("ada", (tx, c) => saveVersion(tx, c, cap, file([earlier, INTERVIEW]), { source: "customize", event: "customize.saved", at: new Date("2026-11-02T15:00:00Z") }));
    // Orbit (Dec 10) and Brightline (Nov 4) were reminded under 60 days; Pinecone's 90-day date (Jul 6) is before the rule's first save.
    expect(await tick("2026-11-03")).toEqual({ ran: 1 });
    expect(await stepOf(lumen)).toBe("due");
    expect(await tick("2026-11-04")).toEqual({ ran: 0 });
    const runs = await k.as("ada", (tx) => tx.select().from(ruleRuns).where(eq(ruleRuns.rowId, lumen)));
    expect(runs.map((r) => [r.ruleId, r.baseDate, r.onDate])).toEqual([["remind", "2027-01-16", "2026-10-18"]]);
  });
});

describe("a date rule from the day a row was added", () => {
  it("runs 14 days after the row was added (6f)", async () => {
    const STALE: Rule = {
      id: "stale",
      text: "If a contract is still in Draft 14 days after it was added, remind its owner.",
      reading: { when: "w", then: "t" },
      trigger: { kind: "date_reached", sheet: "contracts", from: "added", offsetDays: 14 },
      condition: { op: "eq", args: [{ col: "status" }, "active"] },
      actions: [{ kind: "notify", columns: ["owner"], message: "Still in Draft." }],
      enabled: true,
    };
    const drafts = await k.as("ada", (tx, c) => import("./capabilities").then((m) => m.createCapability(tx, c, { ...file([STALE]), name: "Drafts" }, { source: "build", at: new Date("2026-11-05T10:00:00Z") }))).then((r) => r.id);
    const [quill] = await k.as("ada", (tx, c) => importRows(tx, c, drafts, "contracts", [{ values: { customer: "Quill Media", owner: k.id.rita } }], { source: "c.csv", at: new Date("2026-11-06T12:00:00Z") }));
    const tickDrafts = (day: string) => k.as("ada", (tx) => runDateRules(tx, systemCtx(k.workspaceId, six(day)), { capabilityId: drafts }));
    expect(await tickDrafts("2026-11-19")).toEqual({ ran: 0 });
    expect(await tickDrafts("2026-11-20")).toEqual({ ran: 1 });
    const runs = await k.as("ada", (tx) => tx.select().from(ruleRuns).where(eq(ruleRuns.rowId, quill!)));
    expect(runs.map((r) => [r.baseDate, r.onDate])).toEqual([["2026-11-06", "2026-11-20"]]);
  });
});
