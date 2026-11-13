import { beforeAll, describe, expect, it } from "vitest";
import { kernelWorkspace } from "@/tests/kernel";
import type { CapabilityFile } from "./schema/file";
import { createRow, importRows, moveStep } from "./rows";
import { markUpdatesSeen, toDo, updatesFor, waitingOnOthers } from "./inbox";
import { waitingFor } from "./waiting";

// The Inbox (0.5, M31): To do is Waiting on me; Waiting on others is what the rows a person sent wait on; Updates are
// what others did to the rows they sent, are named in or were asked about, only rows they may see, never their own changes.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let timeOff: string;
let hiring: string;
let request: string;
let candidate: string;
let referred: string;
const at = (day: number, min = 0) => new Date(Date.UTC(2026, 9, day, 15, min));

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
        { id: "taken", name: "Taken", end: "final" },
      ],
    },
  ],
  roles: [
    { id: "everyone", name: "Everyone", members: { kind: "everyone" }, can: ["see", "add"], scope: "own", scopeColumns: { requests: { column: "who" } } },
    { id: "managers", name: "Managers", members: { kind: "everyone" }, can: ["see", "move_steps"], moveFrom: ["submitted"], scope: "team", scopeColumns: { requests: { column: "who" } } },
    { id: "admins", name: "Admins", members: { kind: "people", people: [k.id.ada] }, can: ["see", "add"], scope: "all" },
  ],
  rules: [
    { id: "to_manager", text: "Requests go to the person’s manager.", reading: { when: "w", then: "t" }, trigger: { kind: "enters_step", sheet: "requests", step: "submitted" }, actions: [{ kind: "ask_person", managerOf: "who", step: "submitted", label: "Approve or decline" }], enabled: true },
  ],
  later: [],
});

// Candidates (Recruiting only), each with who referred them; an offer waits on Ada.
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
        { id: "referred_by", name: "Referred by", type: "person" },
        { id: "stage", name: "Stage", type: "step" },
      ],
      steps: [
        { id: "applied", name: "Applied", start: true },
        { id: "offer", name: "Offer" },
        { id: "hired", name: "Hired", end: "final" },
      ],
    },
  ],
  roles: [{ id: "recruiting", name: "Recruiting", members: { kind: "people", people: [k.id.ada, k.id.priya] }, can: ["see", "add", "edit", "move_steps"], scope: "all" }],
  rules: [
    { id: "approve_offer", text: "An offer waits on Ada.", reading: { when: "w", then: "t" }, trigger: { kind: "enters_step", sheet: "candidates", step: "offer" }, actions: [{ kind: "ask_person", person: k.id.ada, step: "offer", label: "Approve the offer" }], enabled: true },
  ],
  later: [],
});

beforeAll(async () => {
  k = await kernelWorkspace();
  timeOff = await k.create(timeOffFile());
  hiring = await k.create(hiringFile());
  // Maya asks for Dec 28–31; the rule asks Priya, her manager.
  request = (await k.as("maya", (tx, c) => createRow(tx, c, timeOff, "requests", { values: { from: "2026-12-28" } }), at(20))).id;
  // Priya adds a candidate Maya referred (Maya can't see candidates) and one Rita referred, then moves it to Offer.
  referred = (await k.as("priya", (tx, c) => createRow(tx, c, hiring, "candidates", { values: { name: "Hannah Cole", referred_by: k.id.maya } }), at(19))).id;
  candidate = (await k.as("priya", (tx, c) => createRow(tx, c, hiring, "candidates", { values: { name: "Sam Okafor" } }), at(21))).id;
  await k.as("priya", (tx, c) => moveStep(tx, c, candidate, "offer"), at(22));
});

describe("To do", () => {
  it("is Waiting on me, item for item", async () => {
    const [mine, waiting] = await Promise.all([k.as("priya", (tx, c) => toDo(tx, c), at(27)), k.as("priya", (tx, c) => waitingFor(tx, c), at(27))]);
    expect(mine).toEqual(waiting);
    expect(mine.map((i) => [i.title, i.label])).toEqual([["Maya Chen", "Approve or decline"]]);
  });
});

describe("Waiting on others", () => {
  it("lists the request Maya sent, waiting on Priya since the rule asked", async () => {
    const w = await k.as("maya", (tx, c) => waitingOnOthers(tx, c), at(27));
    expect(w).toEqual([expect.objectContaining({ rowId: request, capability: "Time off", title: "Maya Chen", on: "Priya Nair", label: "Approve or decline", step: "Submitted", since: at(20) })]);
  });

  it("lists what waits on someone else only for the person who sent the row: Priya's offer waits on Ada, Ada has none", async () => {
    expect(await k.as("priya", (tx, c) => waitingOnOthers(tx, c), at(27))).toEqual([expect.objectContaining({ rowId: candidate, on: "Ada Admin", label: "Approve the offer" })]);
    expect(await k.as("ada", (tx, c) => waitingOnOthers(tx, c), at(27))).toEqual([]);
  });
});

describe("Updates", () => {
  it("are what others did to rows a person is part of, never their own changes", async () => {
    const before = await k.as("maya", (tx, c) => updatesFor(tx, c), at(27));
    expect(before).toEqual([]); // only her own add so far; Hannah Cole is a row she can't see
    await k.as("priya", (tx, c) => moveStep(tx, c, request, "approved"), at(23));
    const after = await k.as("maya", (tx, c) => updatesFor(tx, c), at(27));
    expect(after.map((u) => [u.who, u.title, u.capability, u.text])).toEqual([["Priya Nair", "Maya Chen", "Time off", "Moved from Submitted to Approved"]]);
    expect(after[0]!.when).toMatch(/^Oct 23, \d{1,2}:00 [AP]M$/);
  });

  it("count a row a rule asked about, and read a rule's sentence only to admins", async () => {
    const ada = await k.as("ada", (tx, c) => updatesFor(tx, c), at(27));
    expect(ada.map((u) => [u.who, u.title, u.text])).toEqual([
      ["A rule", "Sam Okafor", "“An offer waits on Ada.”: asked Ada Admin"],
      ["Priya Nair", "Sam Okafor", "Moved from Applied to Offer"],
      ["Priya Nair", "Sam Okafor", "Created"],
    ]);
    expect(ada[0]!.byRule).toBe(true);
  });

  it("count a row a person column names them in", async () => {
    await k.as("priya", (tx, c) => createRow(tx, c, hiring, "candidates", { values: { name: "Leo Grant", referred_by: k.id.ada } }), at(24));
    const ada = await k.as("ada", (tx, c) => updatesFor(tx, c), at(27));
    expect(ada[0]).toMatchObject({ who: "Priya Nair", title: "Leo Grant", text: "Created" });
  });

  it("are new until the person opens Updates, then only later entries are", async () => {
    const all = await k.as("ada", (tx, c) => updatesFor(tx, c), at(27));
    expect(all.every((u) => u.isNew)).toBe(true);
    await k.as("ada", (tx, c) => markUpdatesSeen(tx, c), at(27));
    expect((await k.as("ada", (tx, c) => updatesFor(tx, c), at(27))).some((u) => u.isNew)).toBe(false);
    await k.as("priya", (tx, c) => moveStep(tx, c, candidate, "hired"), at(28));
    const later = await k.as("ada", (tx, c) => updatesFor(tx, c), at(28, 5));
    expect(later.filter((u) => u.isNew).map((u) => u.text)).toEqual(["Moved from Offer to Hired"]);
  });

  it("leave out a row the person can't see, though it names them", async () => {
    const maya = await k.as("maya", (tx, c) => updatesFor(tx, c), at(28));
    expect(maya.some((u) => u.rowId === referred)).toBe(false);
  });
});

describe("imports (decided Nov 7)", () => {
  it("send nothing: an imported candidate's changes and waits aren't its importer's", async () => {
    const [ravi] = await k.as("priya", (tx, c) => importRows(tx, c, hiring, "candidates", [{ values: { name: "Ravi Menon" } }], { source: "candidates.csv" }), at(29));
    await k.as("ada", (tx, c) => moveStep(tx, c, ravi!, "offer"), at(29, 5)); // the rule asks Ada
    expect((await k.as("priya", (tx, c) => updatesFor(tx, c), at(30))).some((u) => u.rowId === ravi)).toBe(false);
    expect((await k.as("priya", (tx, c) => waitingOnOthers(tx, c), at(30))).some((w) => w.rowId === ravi)).toBe(false);
  });

  it("aren't an update; a row imported with someone in its creator column is still theirs", async () => {
    const [old] = await k.as("ada", (tx, c) => importRows(tx, c, timeOff, "requests", [{ values: { who: k.id.maya, from: "2026-06-02" } }], { source: "leave.csv" }), at(29));
    const maya = await k.as("maya", (tx, c) => updatesFor(tx, c), at(30));
    expect(maya.some((u) => u.text.startsWith("Imported"))).toBe(false);
    expect((await k.as("maya", (tx, c) => waitingOnOthers(tx, c), at(30))).map((w) => w.rowId)).toContain(old);
    await k.as("priya", (tx, c) => moveStep(tx, c, old!, "approved"), at(29, 10));
    expect((await k.as("maya", (tx, c) => updatesFor(tx, c), at(30)))[0]).toMatchObject({ rowId: old, who: "Priya Nair", text: "Moved from Submitted to Approved" });
  });
});
