import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { auditEntries, waits } from "@/db/schema";
import { kernelWorkspace } from "@/tests/kernel";
import { saveVersion } from "./capabilities";
import type { CapabilityFile } from "./schema/file";
import { createRow, getRow, moveStep, updateRow } from "./rows";
import { decide, reasonFor, waitingCounts, waitingFor, waitsOnRows } from "./waiting";

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let timeOff: string;
let spend: string;
let hiring: string;
const NOW = new Date("2026-10-27T15:00:00Z");

const timeOffFile = (): CapabilityFile => ({
  name: "Time off",
  icon: "calendar-days",
  sheets: [
    {
      id: "requests",
      name: "Requests",
      kind: "list",
      titleColumn: "who",
      row: { one: "request", many: "requests" },
      columns: [
        { id: "who", name: "Who", type: "person", default: { kind: "creator" }, required: true },
        { id: "from", name: "From", type: "date" },
        { id: "status", name: "Status", type: "step" },
      ],
      steps: [
        { id: "submitted", name: "Submitted", start: true },
        { id: "approved", name: "Approved", moveIn: "not_submitter" },
        { id: "declined", name: "Declined", end: "exit", moveIn: "not_submitter" },
        { id: "taken", name: "Taken", end: "final" },
      ],
    },
  ],
  roles: [
    { id: "everyone", name: "Everyone", members: { kind: "everyone" }, can: ["see", "add"], scope: "own", scopeColumns: { requests: { column: "who" } } },
    { id: "managers", name: "Managers", members: { kind: "everyone" }, can: ["see", "move_steps"], moveFrom: ["submitted"], scope: "team", scopeColumns: { requests: { column: "who" } } },
    { id: "admins", name: "Admins", members: { kind: "people", people: [k.id.ada] }, can: ["see", "move_steps"], scope: "all" },
  ],
  rules: [
    { id: "to_manager", text: "Requests go to the person’s manager.", reading: { when: "w", then: "t" }, trigger: { kind: "enters_step", sheet: "requests", step: "submitted" }, actions: [{ kind: "ask_person", managerOf: "who", step: "submitted", label: "Approve or decline" }], enabled: true },
    { id: "tell_approved", text: "Tell the person.", reading: { when: "w", then: "t" }, trigger: { kind: "enters_step", sheet: "requests", step: "approved" }, actions: [{ kind: "notify", columns: ["who"], people: [k.id.rita], message: "Approved." }], enabled: true },
  ],
  later: [],
});

// An expense waits on whoever submitted it while it needs a receipt.
const spendFile = (): CapabilityFile => ({
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
        { id: "status", name: "Status", type: "step" },
      ],
      steps: [
        { id: "needs_receipt", name: "Needs a receipt", start: true, moveOut: "submitter" },
        { id: "submitted", name: "Submitted" },
        { id: "paid", name: "Paid", end: "final" },
      ],
    },
  ],
  roles: [
    { id: "own", name: "Own", members: { kind: "everyone" }, can: ["see", "add", "move_steps"], moveFrom: ["needs_receipt"], scope: "own", scopeColumns: { expenses: { column: "who" } } },
    { id: "finance", name: "Finance", members: { kind: "people", people: [k.id.ada] }, can: ["see", "move_steps"], scope: "all" },
  ],
  rules: [],
  later: [],
});

// Candidates and their interviews: an interview without a score waits on its interviewer; an offer waits on
// Ada's decision.
const hiringFile = (): CapabilityFile => ({
  name: "Hiring",
  icon: "briefcase",
  sheets: [
    {
      id: "candidates",
      name: "Candidates",
      kind: "list",
      titleColumn: "name",
      columns: [
        { id: "name", name: "Name", type: "text", required: true },
        { id: "approval", name: "Offer approval", type: "choice", options: [{ id: "approved", name: "Approved" }, { id: "declined", name: "Declined" }] },
        { id: "stage", name: "Stage", type: "step" },
      ],
      steps: [
        { id: "applied", name: "Applied", start: true },
        { id: "offer", name: "Offer" },
        { id: "hired", name: "Hired", end: "final" },
      ],
    },
    {
      id: "interviews",
      name: "Interviews",
      kind: "list",
      titleColumn: "candidate",
      row: { one: "interview", many: "interviews" },
      columns: [
        { id: "candidate", name: "Candidate", type: "link", link: { sheet: "candidates" }, required: true },
        { id: "interviewer", name: "Interviewer", type: "person" },
        { id: "score", name: "Score", type: "number" },
      ],
    },
  ],
  roles: [
    { id: "recruiting", name: "Recruiting", members: { kind: "people", people: [k.id.ada, k.id.priya] }, can: ["see", "add", "edit", "move_steps"], scope: "all" },
    { id: "interviewers", name: "Interviewers", members: { kind: "column", sheet: "interviews", column: "interviewer" }, can: ["see", "edit"], sheets: ["interviews"], scope: "own", scopeColumns: { interviews: { column: "interviewer" } } },
  ],
  rules: [
    { id: "scorecard", text: "An interview waits on its interviewer for a score.", reading: { when: "w", then: "t" }, trigger: { kind: "row_created", sheet: "interviews" }, actions: [{ kind: "ask_person", column: "interviewer", until: "score", label: "Your scorecard" }], enabled: true },
    { id: "approve_offer", text: "An offer waits on Ada.", reading: { when: "w", then: "t" }, trigger: { kind: "enters_step", sheet: "candidates", step: "offer" }, actions: [{ kind: "ask_person", person: k.id.ada, label: "Approve the offer", decision: { column: "approval", approve: "approved", decline: "declined" } }], enabled: true },
    { id: "send", text: "Approved offers wait on Priya to send.", reading: { when: "w", then: "t" }, trigger: { kind: "field_changed", sheet: "candidates", field: "approval" }, condition: { op: "eq", args: [{ col: "approval" }, "approved"] }, actions: [{ kind: "ask_person", person: k.id.priya, step: "offer", label: "Send the offer" }], enabled: true },
  ],
  later: [],
});

beforeAll(async () => {
  k = await kernelWorkspace();
  timeOff = await k.create(timeOffFile());
  spend = await k.create(spendFile());
  hiring = await k.create(hiringFile());
});

const items = (who: "ada" | "priya" | "maya" | "omar" | "rita") => k.as(who, (tx, c) => waitingFor(tx, c), NOW);

describe("Waiting on me", () => {
  it("lists only rows that name the person: a manager's request waits on Priya, not on Ada who may also move it", async () => {
    const { id } = await k.as("maya", (tx, c) => createRow(tx, c, timeOff, "requests", { values: { from: "2026-12-28" } }), NOW);
    const priya = await items("priya");
    expect(priya.map((i) => [i.capability, i.title, i.step, i.label, i.why])).toEqual([["Time off", "Maya Chen", "Submitted", "Approve or decline", "you are Maya’s manager"]]);
    expect((await items("ada")).some((i) => i.rowId === id)).toBe(false);
    expect(await k.as("priya", (tx, c) => waitingCounts(tx, c), NOW)).toEqual({ [timeOff]: 1 });
  });

  it("says why on the row, and who the rules email once the person decides (X1)", async () => {
    const [item] = await items("priya");
    expect(await k.as("priya", (tx, c) => reasonFor(tx, c, item!.rowId), NOW)).toBe(
      "Waiting on you because you are Maya’s manager. Rule: “Requests go to the person’s manager.” Maya and Rita are emailed when you decide.",
    );
    expect(await k.as("maya", (tx, c) => reasonFor(tx, c, item!.rowId), NOW)).toBeNull();
  });

  it("ends when the row leaves the step", async () => {
    const [item] = await items("priya");
    await k.as("priya", (tx, c) => moveStep(tx, c, item!.rowId, "approved"), NOW);
    expect(await items("priya")).toEqual([]);
  });

  it("a step only the submitter moves on waits on them, and on nobody else", async () => {
    await k.as("maya", (tx, c) => createRow(tx, c, spend, "expenses", { values: { what: "Taxi to SFO" } }), NOW);
    expect((await items("maya")).map((i) => [i.title, i.step, i.waitId])).toEqual([["Taxi to SFO", "Needs a receipt", null]]);
    expect((await items("ada")).filter((i) => i.capabilityId === spend)).toEqual([]);
  });

  it("an until-wait ends when its column is filled, and shows on the row it links to", async () => {
    const { id: cand } = await k.as("priya", (tx, c) => createRow(tx, c, hiring, "candidates", { values: { name: "Tom Weiss" } }), NOW);
    const { id: iv } = await k.as("priya", (tx, c) => createRow(tx, c, hiring, "interviews", { values: { candidate: cand, interviewer: k.id.omar } }), NOW);
    expect((await items("omar")).map((i) => [i.title, i.rowName, i.label, i.step])).toEqual([["Tom Weiss", "Interview", "Your scorecard", null]]);
    const onRows = await k.as("priya", (tx, c) => waitsOnRows(tx, c, hiring, "candidates", [cand]), NOW);
    expect(onRows[cand]).toEqual({ mine: [], others: ["Omar"] });
    await k.as("omar", (tx, c) => updateRow(tx, c, iv, { score: 3 }), NOW);
    expect(await items("omar")).toEqual([]);
  });

  it("a decision is recorded with who, ends the wait and runs the rules that watch it", async () => {
    const { id } = await k.as("priya", (tx, c) => createRow(tx, c, hiring, "candidates", { values: { name: "Sam Okafor" } }), NOW);
    await k.as("priya", (tx, c) => moveStep(tx, c, id, "offer"), NOW);
    await expect(k.as("priya", (tx, c) => moveStep(tx, c, id, "hired"), NOW)).rejects.toThrow("Sam Okafor is waiting on Ada Admin to decide.");
    const [mine] = (await items("ada")).filter((i) => i.rowId === id);
    expect(mine).toMatchObject({ decision: true, label: "Approve the offer" });
    await expect(k.as("priya", (tx, c) => decide(tx, c, mine!.waitId!, "approve"), NOW)).rejects.toThrow("That isn't waiting on you.");
    await k.as("ada", (tx, c) => decide(tx, c, mine!.waitId!, "approve"), NOW);
    expect((await k.as("ada", (tx, c) => getRow(tx, c, id))).data.approval).toBe("approved");
    expect((await items("priya")).filter((i) => i.rowId === id).map((i) => i.label)).toEqual(["Send the offer"]);
    const [entry] = await k.as("ada", (tx) => tx.select().from(auditEntries).where(eq(auditEntries.event, "row.decided")));
    expect(entry).toMatchObject({ who: k.email("ada"), details: { sheet: "Candidates", row: "Sam Okafor", "Offer approval": "Approved" } });
    const [cleared] = await k.as("ada", (tx) => tx.select().from(waits).where(and(eq(waits.rowId, id), eq(waits.ruleId, "approve_offer"))));
    expect(cleared).toMatchObject({ decided: "approved", decidedBy: k.id.ada });
    // Now Priya may move it on.
    await k.as("priya", (tx, c) => moveStep(tx, c, id, "hired"), NOW);
    expect(await k.as("ada", (tx) => tx.select().from(waits).where(and(eq(waits.rowId, id), isNull(waits.clearedAt))))).toEqual([]);
  });

  it("never lists a row the person can no longer see", async () => {
    const { id } = await k.as("maya", (tx, c) => createRow(tx, c, timeOff, "requests", { values: { from: "2027-01-04" } }), NOW);
    expect((await items("priya")).some((i) => i.rowId === id)).toBe(true);
    // The managers' role is taken away: the wait stays recorded, but Priya can't see the row.
    const file = timeOffFile();
    file.roles = file.roles.filter((r) => r.id !== "managers");
    await k.as("ada", (tx, c) => saveVersion(tx, c, timeOff, file, { source: "customize", event: "customize.saved" }), NOW);
    expect((await items("priya")).some((i) => i.rowId === id)).toBe(false);
  });
});
