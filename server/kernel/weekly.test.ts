import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { outbox, weeklyEmails } from "@/db/schema";
import { outbox as sent } from "@/server/email/send";
import { sendOutbox, tick } from "@/server/jobs/tick";
import { kernelWorkspace } from "@/tests/kernel";
import { record } from "./audit";
import { startChat } from "./chats";
import { createRow, importRows, moveStep } from "./rows";
import type { CapabilityFile } from "./schema/file";
import { addAdmin } from "./settings";
import { addDays, weekRange, weekSummary, type Weekly } from "./weekly";

// M34 · What changed this week, through the hourly job: on a Monday from 07:00 in the company's time zone each admin
// gets one email about last week (Monday to Sunday), counted by the kernel from the Audit log for the apps that admin
// can see, in fixed sentences. A quiet week sends a short one. Nobody else gets it; nothing on other days.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let other: Awaited<ReturnType<typeof kernelWorkspace>>;
let spend: string;
const at = (iso: string) => new Date(iso);
const IN_WEEK = at("2026-11-03T16:00:00Z"); // Tue Nov 3, 10:00 in Chicago
const MONDAY_0630 = at("2026-11-09T12:30:00Z");
const MONDAY_0730 = at("2026-11-09T13:30:00Z");

const spendFile = (): CapabilityFile => ({
  name: "Spend",
  icon: "wallet",
  sheets: [
    {
      id: "purchases",
      name: "Purchases",
      kind: "list",
      titleColumn: "what",
      row: { one: "purchase", many: "purchases" },
      columns: [
        { id: "what", name: "What", type: "text", required: true },
        { id: "amount", name: "Amount", type: "money" },
        { id: "who", name: "Who", type: "person", default: { kind: "creator" } },
        { id: "status", name: "Status", type: "step" },
      ],
      steps: [{ id: "submitted", name: "Submitted", start: true }, { id: "approved", name: "Approved", end: "final" }],
    },
    {
      id: "vendors",
      name: "Vendors",
      kind: "list",
      titleColumn: "name",
      row: { one: "vendor", many: "vendors" },
      columns: [{ id: "name", name: "Name", type: "text", required: true }],
    },
  ],
  roles: [
    { id: "admins", name: "Admins", members: { kind: "people", people: [k.id.ada, k.id.priya] }, can: ["see", "add", "edit", "move_steps"], scope: "all" },
    { id: "everyone", name: "Everyone", members: { kind: "everyone" }, can: ["see", "add"], sheets: ["purchases"], scope: "own", scopeColumns: { purchases: { column: "who" } } },
  ],
  rules: [
    { id: "ask_priya", text: "A new purchase waits on Priya.", reading: { when: "w", then: "t" }, trigger: { kind: "row_created", sheet: "purchases" }, actions: [{ kind: "ask_person", person: k.id.priya, step: "submitted", label: "Approve it" }], enabled: true },
  ],
  later: [],
});

// An app only Ada can see.
const boardFile = (): CapabilityFile => ({
  name: "Board",
  icon: "landmark",
  sheets: [{ id: "minutes", name: "Minutes", kind: "list", titleColumn: "title", row: { one: "minute", many: "minutes" }, columns: [{ id: "title", name: "Title", type: "text", required: true }] }],
  roles: [{ id: "ada", name: "Ada", members: { kind: "people", people: [k.id.ada] }, can: ["see", "add"], scope: "all" }],
  rules: [],
  later: [],
});

const only = () => ({ workspaceId: k.workspaceId });
const summaries = async () =>
  (await k.as("ada", (tx) => tx.select({ personId: outbox.personId, payload: outbox.payload }).from(outbox).where(eq(outbox.kind, "weekly")))).map((o) => ({
    personId: o.personId,
    week: o.payload as Weekly,
  }));

beforeAll(async () => {
  k = await kernelWorkspace();
  other = await kernelWorkspace();
  await k.as("ada", (tx, c) => addAdmin(tx, c, k.id.priya));
  spend = await k.create(spendFile());
  const board = await k.create(boardFile());

  // Last week, Monday Nov 2 to Sunday Nov 8 in Chicago.
  const laptop = await k.as("maya", (tx, c) => createRow(tx, c, spend, "purchases", { values: { what: "Laptop", amount: 200000 } }), IN_WEEK);
  await k.as("maya", (tx, c) => createRow(tx, c, spend, "purchases", { values: { what: "Monitor", amount: 30000 } }), IN_WEEK);
  await k.as("ada", (tx, c) => createRow(tx, c, spend, "vendors", { values: { name: "Dell" } }), IN_WEEK);
  await k.as("ada", (tx, c) => importRows(tx, c, spend, "vendors", [{ values: { name: "Apple" } }, { values: { name: "Lenovo" } }], { source: "vendors.csv", at: IN_WEEK }), IN_WEEK);
  await k.as("ada", (tx, c) => moveStep(tx, c, laptop.id, "approved"), at("2026-11-04T16:00:00Z"));
  await k.as("ada", (tx, c) => createRow(tx, c, board, "minutes", { values: { title: "October board" } }), IN_WEEK);
  // A repeating rule that added nothing, as the kernel logs it (repeats.ts).
  await k.as("ada", (tx, c) =>
    record(tx, c, { who: "rule:rent", capabilityId: spend, event: "rule.ran", details: { sheet: "Purchases", rule: "Every month on the 1st, add the rent.", on: "2026-11-01", did: "nothing added", stopped: "Amount must be a number." }, at: at("2026-11-05T12:00:00Z") }),
  );
  // Outside the week: Sunday Nov 1 at 23:00 in Chicago, and Monday Nov 9.
  await k.as("ada", (tx, c) => createRow(tx, c, spend, "vendors", { values: { name: "Before" } }), at("2026-11-02T05:00:00Z"));
  await k.as("ada", (tx, c) => createRow(tx, c, spend, "vendors", { values: { name: "After" } }), at("2026-11-09T07:00:00Z"));
  // Another company's busy week.
  const theirs = await other.create({ ...spendFile(), roles: [{ id: "all", name: "All", members: { kind: "everyone" }, can: ["see", "add"], scope: "all" }], rules: [] });
  await other.as("ada", (tx, c) => createRow(tx, c, theirs, "vendors", { values: { name: "Theirs" } }), IN_WEEK);
}, 60_000);

describe("the week in words", () => {
  it("names its week as people write it", () => {
    expect(weekRange("2026-11-02")).toBe("Nov 2–8");
    expect(weekRange("2026-10-26")).toBe("Oct 26–Nov 1");
    expect(weekRange("2026-10-26", { dates: "dmy" } as never)).toBe("26 Oct–1 Nov");
    expect(weekRange("2026-11-02", { dates: "dmy" } as never)).toBe("2–8 Nov");
    expect(addDays("2026-11-09", -7)).toBe("2026-11-02");
  });

  it("counts last week for Ada: per app what was added and moved on, the rules, what stopped, what waited longest", async () => {
    const w = await k.as("ada", (tx, c) => weekSummary(tx, c, "2026-11-02"), MONDAY_0730);
    expect(w).toMatchObject({
      range: "Nov 2–8",
      days: "Monday Nov 2 to Sunday Nov 8",
      added: [
        { app: "Spend", text: "2 purchases and 3 vendors added, 2 of them from imports · 1 moved on, 1 to Approved" },
        { app: "Board", text: "1 minute added" },
      ],
      rules: "Rules ran 2 times, in Spend.",
      stopped: [{ app: "Spend", text: "“Every month on the 1st, add the rent.” added nothing on Nov 1: Amount must be a number." }],
      waiting: [{ app: "Spend", title: "Monitor", text: "waits on Priya Nair · 5 days in Submitted" }],
      quiet: false,
    });
  });

  it("is the same every time it is counted", async () => {
    const once = await k.as("ada", (tx, c) => weekSummary(tx, c, "2026-11-02"), MONDAY_0730);
    expect(await k.as("ada", (tx, c) => weekSummary(tx, c, "2026-11-02"), MONDAY_0730)).toEqual(once);
  });

  it("leaves out an app the admin can't see; only admins can ask", async () => {
    const w = await k.as("priya", (tx, c) => weekSummary(tx, c, "2026-11-02"), MONDAY_0730);
    expect(w.added.map((a) => a.app)).toEqual(["Spend"]);
    await expect(k.as("maya", (tx, c) => weekSummary(tx, c, "2026-11-02"), MONDAY_0730)).rejects.toThrow("Only admins");
  });
});

describe("a scheduled report that couldn't run", () => {
  it("is listed for its author only: another admin's report chats aren't theirs to read", async () => {
    const { chatId } = await k.as("ada", (tx, c) => startChat(tx, c, "report", { text: "Spend by region?" }), IN_WEEK);
    await k.as("ada", (tx, c) =>
      record(tx, c, { who: k.email("ada"), capabilityId: spend, event: "report.emailed", details: { report: "“Spend by region”", to: k.email("ada"), problem: "Purchases has no Region column." }, chatId, at: at("2026-11-06T13:30:00Z") }),
    );
    const ada = await k.as("ada", (tx, c) => weekSummary(tx, c, "2026-11-02"), MONDAY_0730);
    expect(ada.stopped.map((s) => s.text)).toContain("“Spend by region” was emailed without its numbers: Purchases has no Region column.");
    const priya = await k.as("priya", (tx, c) => weekSummary(tx, c, "2026-11-02"), MONDAY_0730);
    expect(priya.stopped.map((s) => s.text)).toEqual(["“Every month on the 1st, add the rent.” added nothing on Nov 1: Amount must be a number."]);
  });
});

describe("the Monday email", () => {
  it("waits for Monday 07:00, then queues one for each admin and nobody else, once", async () => {
    await tick(at("2026-11-08T13:30:00Z"), only()); // Sunday
    await tick(MONDAY_0630, only());
    expect(await summaries()).toEqual([]);
    await tick(MONDAY_0730, only());
    await tick(at("2026-11-09T14:30:00Z"), only()); // again at 08:30: nothing new
    await tick(at("2026-11-10T13:30:00Z"), only()); // Tuesday: nothing
    const queued = await summaries();
    expect(queued.map((q) => q.personId).sort()).toEqual([k.id.ada, k.id.priya].sort());
    expect(queued.every((q) => q.week.weekOf === "2026-11-02")).toBe(true);
    const rows = await k.as("ada", (tx) => tx.select({ weekOf: weeklyEmails.weekOf, quiet: weeklyEmails.quiet }).from(weeklyEmails));
    expect(rows).toEqual([{ weekOf: "2026-11-02", quiet: false }, { weekOf: "2026-11-02", quiet: false }]);
  });

  it("emails it in fixed words, each line as counted", async () => {
    await sendOutbox(only());
    const mail = sent().find((e) => e.to === k.email("ada") && e.subject.startsWith("What changed"))!;
    expect(mail.subject).toMatch(/^What changed at t\w+ Labs, Nov 2–8$/);
    expect(mail.text).toContain("here is what changed in Bike last week, Monday Nov 2 to Sunday Nov 8.");
    expect(mail.text).toContain("Spend  2 purchases and 3 vendors added, 2 of them from imports · 1 moved on, 1 to Approved");
    expect(mail.text).toContain("Board  1 minute added");
    expect(mail.text).toContain("Rules ran 2 times, in Spend.");
    expect(mail.text).toContain("Spend  Monitor · waits on Priya Nair · 5 days in Submitted");
    expect(mail.html).toContain("Open the Audit log");
    const priya = sent().find((e) => e.to === k.email("priya") && e.subject.startsWith("What changed"))!;
    expect(priya.text).not.toContain("Board");
    expect(sent().filter((e) => [k.email("maya"), k.email("omar"), k.email("rita")].includes(e.to) && /What changed|quiet week/.test(e.subject))).toEqual([]);
    expect(sent().some((e) => e.text.includes("Theirs"))).toBe(false);
  }, 30_000);

  it("sends a short one after a quiet week, still listing what waits", async () => {
    await tick(at("2026-11-16T13:30:00Z"), only()); // Monday Nov 16: Nov 9–15 had only "After", early on the 9th
    const week = (await summaries()).find((q) => q.personId === k.id.priya && q.week.weekOf === "2026-11-09")!.week;
    expect(week).toMatchObject({ added: [{ app: "Spend", text: "1 vendor added" }], quiet: false });

    await tick(at("2026-11-23T13:30:00Z"), only()); // Monday Nov 23: Nov 16–22 had nothing
    await sendOutbox(only());
    const mail = sent().find((e) => e.to === k.email("ada") && e.subject.includes("quiet week"))!;
    expect(mail.subject).toMatch(/^A quiet week at t\w+ Labs, Nov 16–22$/);
    expect(mail.text).toContain("nothing changed in Bike last week, Monday Nov 16 to Sunday Nov 22: no rows were added or moved and no rules ran.");
    expect(mail.text).toContain("Waiting longest");
    expect(mail.text).toContain("Monitor · waits on Priya Nair · 19 days in Submitted");
  }, 30_000);
});
