import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { auditEntries, savedReports } from "@/db/schema";
import { kernelWorkspace } from "@/tests/kernel";
import { addMessage, startChat } from "../chats";
import { addAdmin } from "../settings";
import { checkEvery, dueOn, everyWords, listSaved, nextSend, owedOn, savedState, saveForLater, setSchedule, unsave } from "./saved";
import { saveReport } from "./store";
import type { ReportResult } from "./schema";

// M33 · Saved and scheduled reports: only the admin who asked for a report saves it, lists it and schedules it; each
// change is in the Audit log; a schedule is checked before it is kept.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
const result: ReportResult = { columns: [{ name: "Team", format: "text" }], rows: [["Engineering"]], sources: [{ capability: "Spend", sheet: "Purchases", name: "Purchases", read: 128, leftOut: 6 }] };
const query = { from: [], join: [], where: null, groupBy: [], measures: [], computed: [], orderBy: [], limit: null };
const MON = new Date("2026-11-09T13:30:00Z"); // Mon Nov 9, 07:30 in Chicago

async function ask(who: "ada" | "priya", title: string) {
  const { chatId } = await k.as(who, (tx, c) => startChat(tx, c, "report", { text: `${title}?` }));
  const messageId = await k.as(who, (tx, c) => addMessage(tx, c, chatId, { from: "bike", text: "" }));
  const first = await k.as(who, (tx, c) => saveReport(tx, c, { chatId, messageId, title, query, chart: "bar", how: [], missing: null, sentence: "Done.", result }));
  const again = await k.as(who, (tx, c) => saveReport(tx, c, { chatId, messageId, firstId: first.id, title, query, chart: "bar", how: [], missing: null, sentence: "Again.", result }));
  return { chatId, first: first.id, again: again.id };
}

const events = (chatId: string) => k.as("ada", (tx) => tx.select({ event: auditEntries.event, details: auditEntries.details }).from(auditEntries).where(and(eq(auditEntries.chatId, chatId), inArray(auditEntries.event, ["report.saved", "report.unsaved", "report.scheduled", "report.unscheduled"]))));

beforeAll(async () => {
  k = await kernelWorkspace();
  await k.as("ada", (tx, c) => addAdmin(tx, c, k.id.priya));
});

describe("schedules", () => {
  it("are every day, every week on a weekday or every month on a day; anything else is refused in plain words", () => {
    expect(checkEvery({ unit: "week", weekday: 1, extra: true })).toEqual({ unit: "week", weekday: 1 });
    expect(() => checkEvery({ unit: "week", weekday: 8 })).toThrow("Choose a day of the week.");
    expect(() => checkEvery({ unit: "month", day: 0 })).toThrow("Choose a day of the month, from the 1st to the 31st.");
    expect(() => checkEvery({ unit: "hour" })).toThrow("Choose every day, every week or every month.");
    expect(() => checkEvery(null)).toThrow("Choose every day, every week or every month.");
    expect([{ unit: "day" as const }, { unit: "week" as const, weekday: 1 }, { unit: "month" as const, day: 1 }].map(everyWords)).toEqual(["Every day", "Every Monday", "Every month on the 1st"]);
  });

  it("send on their dates; the 31st sends on a short month's last day", () => {
    expect(dueOn({ unit: "week", weekday: 1 }, "2026-11-09")).toBe(true);
    expect(dueOn({ unit: "week", weekday: 1 }, "2026-11-10")).toBe(false);
    expect(dueOn({ unit: "month", day: 31 }, "2026-11-30")).toBe(true);
    expect(nextSend({ unit: "week", weekday: 1 }, "2026-11-10")).toBe("2026-11-16");
  });

  it("owe one send for the latest date in the last week, never before the schedule was set", () => {
    const monday = { unit: "week" as const, weekday: 1 };
    expect(owedOn(monday, "2026-11-01", "2026-11-11")).toBe("2026-11-09"); // Monday missed, sent late on Wednesday
    expect(owedOn(monday, "2026-11-10", "2026-11-11")).toBeNull(); // set on Tuesday: next Monday is the first
    expect(owedOn({ unit: "day" }, "2026-11-01", "2026-11-11")).toBe("2026-11-11");
  });
});

describe("saving a report", () => {
  it("lists it on Reports by its latest run, logs report.saved once, and unsaving takes it off and stops its emails", async () => {
    const r = await ask("ada", "Spend by team, Q4");
    await k.as("ada", (tx, c) => saveForLater(tx, c, r.again));
    await k.as("ada", (tx, c) => saveForLater(tx, c, r.first)); // the same report: nothing new
    const list = await k.as("ada", (tx, c) => listSaved(tx, c));
    expect(list).toMatchObject([{ reportId: r.again, title: "Spend by team, Q4", apps: "Spend", emailed: "", href: `/home?chat=${r.chatId}&report=${r.again}` }]);

    await k.as("ada", (tx, c) => setSchedule(tx, c, r.first, { unit: "week", weekday: 1 }), MON);
    expect((await k.as("ada", (tx, c) => listSaved(tx, c)))[0]!.emailed).toBe("Every Monday");
    // Set on Monday after 07:00: the next one is the Monday after.
    expect(await k.as("ada", (tx, c) => savedState(tx, c, r.again), MON)).toEqual({ saved: true, every: { unit: "week", weekday: 1 }, next: "Mon, Nov 16" });
    // And the job agrees: nothing is owed that Monday.
    const [row] = await k.as("ada", (tx) => tx.select({ since: savedReports.everySince }).from(savedReports).where(eq(savedReports.chatId, r.chatId)));
    expect(owedOn({ unit: "week", weekday: 1 }, row!.since!, "2026-11-09")).toBeNull();

    await k.as("ada", (tx, c) => unsave(tx, c, r.again));
    expect(await k.as("ada", (tx, c) => listSaved(tx, c))).toEqual([]);
    expect(await k.as("ada", (tx, c) => savedState(tx, c, r.again))).toEqual({ saved: false, every: null, next: null });
    await k.as("ada", (tx, c) => saveForLater(tx, c, r.again));
    expect((await k.as("ada", (tx, c) => listSaved(tx, c)))[0]!.emailed).toBe(""); // saved again, not emailed until scheduled again

    expect(await events(r.chatId)).toEqual([
      { event: "report.saved", details: { report: "“Spend by team, Q4”" } },
      { event: "report.scheduled", details: { report: "“Spend by team, Q4”", every: "Every Monday" } },
      { event: "report.unsaved", details: { report: "“Spend by team, Q4”" } },
      { event: "report.saved", details: { report: "“Spend by team, Q4”" } },
    ]);
  });

  it("must be saved before it is scheduled; a bad schedule is refused; stopping it is logged", async () => {
    const r = await ask("ada", "Cloud spend");
    await expect(k.as("ada", (tx, c) => setSchedule(tx, c, r.first, { unit: "day" }))).rejects.toThrow("Save the report first.");
    await k.as("ada", (tx, c) => saveForLater(tx, c, r.first));
    await expect(k.as("ada", (tx, c) => setSchedule(tx, c, r.first, { unit: "week", weekday: 9 }))).rejects.toThrow("Choose a day of the week.");
    await k.as("ada", (tx, c) => setSchedule(tx, c, r.first, { unit: "month", day: 1 }));
    await k.as("ada", (tx, c) => setSchedule(tx, c, r.first, null));
    expect((await events(r.chatId)).map((e) => e.event)).toEqual(["report.saved", "report.scheduled", "report.unscheduled"]);
  });
});

describe("only the admin who asked", () => {
  it("saves, schedules and sees a saved report: another admin and an employee are refused, by the kernel and by the table", async () => {
    const r = await ask("ada", "November starters");
    await k.as("ada", (tx, c) => saveForLater(tx, c, r.first));
    for (const who of ["priya", "maya"] as const) {
      await expect(k.as(who, (tx, c) => saveForLater(tx, c, r.first))).rejects.toThrow();
      await expect(k.as(who, (tx, c) => unsave(tx, c, r.first))).rejects.toThrow();
      await expect(k.as(who, (tx, c) => setSchedule(tx, c, r.first, { unit: "day" }))).rejects.toThrow();
      await expect(k.as(who, (tx, c) => savedState(tx, c, r.first))).rejects.toThrow();
      expect(await k.as(who, (tx) => tx.select().from(savedReports))).toEqual([]);
    }
    await expect(k.as("maya", (tx, c) => listSaved(tx, c))).rejects.toThrow("Only admins can do that.");
    expect(await k.as("priya", (tx, c) => listSaved(tx, c))).toEqual([]);
    // Priya's own report is hers alone.
    const mine = await ask("priya", "Hiring this month");
    await k.as("priya", (tx, c) => saveForLater(tx, c, mine.first));
    expect((await k.as("priya", (tx, c) => listSaved(tx, c))).map((s) => s.title)).toEqual(["Hiring this month"]);
    expect((await k.as("ada", (tx, c) => listSaved(tx, c))).map((s) => s.title)).not.toContain("Hiring this month");
  });

  it("never in another workspace", async () => {
    const other = await kernelWorkspace();
    const r = await ask("ada", "Spend elsewhere");
    await expect(other.as("ada", (tx, c) => saveForLater(tx, c, r.first))).rejects.toThrow();
    expect(await other.as("ada", (tx) => tx.select().from(savedReports))).toEqual([]);
  });
});
