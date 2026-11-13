import { beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { auditEntries, repeatRuns, waits } from "@/db/schema";
import { kernelWorkspace } from "@/tests/kernel";
import { createCapability, saveVersion } from "./capabilities";
import { systemCtx } from "./date-rules";
import { rowHistory, sentences } from "./history";
import { datesFor, everyWords, isDue, nextDate, runRepeats } from "./repeats";
import { listRows } from "./rows";
import { previewRepeatRule, previewRule } from "./preview";
import { validateFile } from "./schema/validate";
import type { CapabilityFile, Rule } from "./schema/file";

type K = Awaited<ReturnType<typeof kernelWorkspace>>;
let k: K;
// 06:00 in Chicago on a given day.
const six = (day: string) => new Date(`${day}T12:00:00Z`);
const SAVED = new Date("2026-11-08T16:00:00Z"); // Nov 8 in Chicago

const rent = (who: string, over: Partial<Rule["trigger"]> = {}, id = "rent"): Rule => ({
  id,
  text: "Every month on the 1st, add the office rent to Expenses: $2,400, Office, paid with the company card, for Ada.",
  reading: { when: "Every month on the 1st", then: "Add an expense: Office rent, $2,400" },
  trigger: { kind: "repeats", sheet: "expenses", every: { unit: "month", day: 1 }, ...over },
  actions: [{ kind: "create_row_in", target: { sheet: "expenses" }, map: { what: "Office rent", who, date: { ref: "today" }, amount: 240000, category: "office", paid_with: "company_card" } }],
  enabled: true,
});

// Spend's expenses, as the seed has them in short: a row without a receipt waits on whoever it is for.
const spend = (rules: Rule[], admin: string): CapabilityFile => ({
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
        { id: "who", name: "Who", type: "person", required: true, default: { kind: "creator" } },
        { id: "date", name: "Date", type: "date", required: true },
        { id: "amount", name: "Amount", type: "money", required: true },
        { id: "category", name: "Category", type: "choice", options: [{ id: "office", name: "Office" }, { id: "travel", name: "Travel" }] },
        { id: "paid_with", name: "Paid with", type: "choice", options: [{ id: "own_card", name: "My own card" }, { id: "company_card", name: "Company card" }] },
        { id: "receipt", name: "Receipt", type: "file" },
        { id: "status", name: "Status", type: "step" },
      ],
      steps: [{ id: "needs_receipt", name: "Needs a receipt", start: true }, { id: "submitted", name: "Submitted" }, { id: "paid", name: "Paid", end: "final" }],
    },
  ],
  roles: [
    { id: "finance", name: "Finance", members: { kind: "people", people: [admin] }, can: ["see", "add", "edit", "delete", "move_steps", "customize"], scope: "all" },
    { id: "everyone", name: "Everyone", members: { kind: "everyone" }, can: ["see", "add", "edit"], scope: "own", scopeColumns: { expenses: { column: "who" } } },
  ],
  rules: [
    {
      id: "receipt",
      text: "An expense without its receipt waits on its person to attach it.",
      reading: { when: "w", then: "t" },
      trigger: { kind: "row_created", sheet: "expenses" },
      condition: { op: "empty", args: [{ col: "receipt" }] },
      actions: [{ kind: "ask_person", column: "who", until: "receipt", label: "Attach the receipt" }],
      enabled: true,
    },
    ...rules,
  ],
  later: [],
});

const make = (kk: K, rules: Rule[]) => kk.as("ada", (tx, c) => createCapability(tx, c, spend(rules, kk.id.ada), { source: "build", at: SAVED })).then((r) => r.id);
const tick = (kk: K, day: string, capabilityId?: string) => kk.as("ada", (tx) => runRepeats(tx, systemCtx(kk.workspaceId, six(day)), { capabilityId }));
const rows = (kk: K, cap: string, who: "ada" | "maya" = "ada") => kk.as(who, (tx, c) => listRows(tx, c, cap, "expenses"));

describe("schedules", () => {
  it("every month on a day, the 29th to 31st on a shorter month's last day", () => {
    const m31 = { unit: "month", day: 31 } as const;
    expect(datesFor(m31, "2027-01-01", "2027-05-31")).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30", "2027-05-31"]);
    expect(datesFor({ unit: "month", day: 29 }, "2028-02-01", "2028-03-31")).toEqual(["2028-02-29", "2028-03-29"]);
    expect(datesFor({ unit: "month", day: 1 }, "2026-11-08", "2027-02-02")).toEqual(["2026-12-01", "2027-01-01", "2027-02-01"]);
  });

  it("every week on a weekday, every year on a date (Feb 29 on Feb 28 in other years)", () => {
    expect(datesFor({ unit: "week", weekday: 1 }, "2026-11-01", "2026-11-30")).toEqual(["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"]);
    expect(datesFor({ unit: "year", month: 3, day: 1 }, "2026-01-01", "2028-12-31")).toEqual(["2026-03-01", "2027-03-01", "2028-03-01"]);
    expect(isDue({ unit: "year", month: 2, day: 29 }, "2027-02-28")).toBe(true);
    expect(isDue({ unit: "year", month: 2, day: 29 }, "2028-02-28")).toBe(false);
  });

  it("names the next date, none after it ends, and reads in words", () => {
    expect(nextDate({ unit: "month", day: 1 }, "2026-11-08")).toBe("2026-12-01");
    expect(nextDate({ unit: "month", day: 1 }, "2026-11-08", "2026-11-30")).toBeNull();
    expect(everyWords({ unit: "month", day: 1 })).toBe("Every month on the 1st");
    expect(everyWords({ unit: "month", day: 22 })).toBe("Every month on the 22nd");
    expect(everyWords({ unit: "month", day: 13 })).toBe("Every month on the 13th");
    expect(everyWords({ unit: "week", weekday: 1 })).toBe("Every week on Monday");
    expect(everyWords({ unit: "year", month: 3, day: 1 })).toBe("Every year on Mar 1");
    expect(everyWords({ unit: "year", month: 3, day: 1 }, { dates: "dmy" } as never)).toBe("Every year on 1 Mar");
  });
});

describe("rows that repeat", () => {
  let cap: string;
  beforeAll(async () => {
    k = await kernelWorkspace();
    cap = await make(k, [rent(k.id.ada)]);
  });

  it("adds nothing before its first date, then the office rent on Dec 1, once", async () => {
    expect(await tick(k, "2026-11-08")).toEqual({ added: 0 });
    expect(await tick(k, "2026-11-30")).toEqual({ added: 0 });
    expect(await tick(k, "2026-12-01")).toEqual({ added: 1 });
    expect(await tick(k, "2026-12-01")).toEqual({ added: 0 });
    expect(await tick(k, "2026-12-15")).toEqual({ added: 0 });
    const [row, ...more] = await rows(k, cap);
    expect(more).toHaveLength(0);
    expect(row!.data).toMatchObject({ what: "Office rent", who: k.id.ada, date: "2026-12-01", amount: 240000, category: "office", paid_with: "company_card", status: "needs_receipt" });
    expect(row!.createdBy).toBeNull();
  });

  it("goes through the write path: the sheet's own rules run on the row it adds", async () => {
    const [row] = await rows(k, cap);
    const asked = await k.as("ada", (tx) => tx.select().from(waits).where(eq(waits.rowId, row!.id)));
    expect(asked).toMatchObject([{ personId: k.id.ada, label: "Attach the receipt" }]);
  });

  it("logs one rule.ran entry naming the date and the row; History reads it", async () => {
    const [row] = await rows(k, cap);
    const entries = await k.as("ada", (tx) => tx.select().from(auditEntries).where(and(eq(auditEntries.event, "rule.ran"), eq(auditEntries.who, "rule:rent"))));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ rowIds: [row!.id], details: { on: "2026-12-01", did: "added Expenses/Office rent", sheet: "Expenses" } });
    const history = await k.as("ada", (tx, c) => rowHistory(tx, c, row!.id));
    // Newest first: the receipt rule it set off, then the row added.
    expect(history.filter((h) => h.kind === "change").map((h) => [h.who, h.text])).toEqual([
      ["A rule", "“An expense without its receipt waits on its person to attach it.”: asked Ada Admin"],
      ["A rule", "Added: “Every month on the 1st, add the office rent to Expenses: $2,400, Office, paid with the company card, for Ada”"],
    ]);
  });

  it("reads as added by a rule to someone who isn't an admin", () => {
    const sheet = spend([], k.id.ada).sheets[0]!;
    const d = { sheet: "Expenses", rule: "Every month on the 1st, add the office rent.", on: "2026-12-01", did: "added Expenses/Office rent" };
    expect(sentences(sheet, "rule.ran", d, { first: true, admin: false, fmt: { dates: "mdy" } as never })).toEqual(["Added by a rule"]);
  });

  it("catches up a missed stretch, one row per date, each dated its own day", async () => {
    expect(await tick(k, "2027-02-02")).toEqual({ added: 2 });
    expect((await rows(k, cap)).map((r) => r.data.date).sort()).toEqual(["2026-12-01", "2027-01-01", "2027-02-01"]);
    const runs = await k.as("ada", (tx) => tx.select({ on: repeatRuns.onDate }).from(repeatRuns).orderBy(asc(repeatRuns.onDate)));
    expect(runs.map((r) => r.on)).toEqual(["2026-12-01", "2027-01-01", "2027-02-01"]);
  });

  it("is never seen by someone the rows aren't for", async () => {
    expect(await rows(k, cap, "maya")).toEqual([]);
  });

  it("stops when turned off, and when removed", async () => {
    const off = spend([{ ...rent(k.id.ada), enabled: false }], k.id.ada);
    await k.as("ada", (tx, c) => saveVersion(tx, c, cap, off, { source: "customize", event: "customize.saved", at: six("2027-02-10") }));
    expect(await tick(k, "2027-03-02")).toEqual({ added: 0 });
    await k.as("ada", (tx, c) => saveVersion(tx, c, cap, spend([], k.id.ada), { source: "customize", event: "customize.saved", at: six("2027-03-10") }));
    expect(await tick(k, "2027-04-02")).toEqual({ added: 0 });
  });

  it("weekly and yearly rules add on their dates; an end date stops it; the same days give the same rows", async () => {
    const run = async () => {
      const kk = await kernelWorkspace();
      const c = await make(kk, [
        { ...rent(kk.id.ada, { every: { unit: "week", weekday: 1 }, ends: "2026-11-23" }, "weekly"), text: "Every Monday until Nov 23, add the office rent." },
        { ...rent(kk.id.ada, { every: { unit: "year", month: 3, day: 1 } }, "yearly"), text: "Every year on Mar 1, add the office rent." },
      ]);
      await tick(kk, "2026-12-01");
      await tick(kk, "2027-03-05");
      return (await rows(kk, c)).map((r) => r.data.date).sort();
    };
    const first = await run();
    expect(first).toEqual(["2026-11-09", "2026-11-16", "2026-11-23", "2027-03-01"]);
    expect(await run()).toEqual(first);
  });

  it("a row the kernel refuses is logged for admins, its date stays done, and the other rules go on", async () => {
    const kk = await kernelWorkspace();
    const file = spend([rent(kk.id.ada, {}, "rent"), { ...rent(kk.id.ada, {}, "nights"), text: "Every month on the 1st, book 12 nights." }], kk.id.ada);
    const sheet = file.sheets[0]!;
    sheet.columns.push({ id: "nights", name: "Nights", type: "number", max: 10 });
    (file.rules[2]!.actions[0] as { map: Record<string, unknown> }).map.nights = 12;
    const c = await kk.as("ada", (tx, cx) => createCapability(tx, cx, file, { source: "build", at: SAVED })).then((r) => r.id);
    expect(await tick(kk, "2026-12-01")).toEqual({ added: 1 });
    expect(await tick(kk, "2026-12-01")).toEqual({ added: 0 });
    expect((await rows(kk, c)).map((r) => r.data.nights ?? null)).toEqual([null]);
    const [refused] = await kk.as("ada", (tx) => tx.select().from(auditEntries).where(eq(auditEntries.who, "rule:nights")));
    expect(refused).toMatchObject({ event: "rule.ran", rowIds: null, details: { on: "2026-12-01", did: "nothing added", stopped: "Nights must be at most 10." } });
  });

  it("never adds in another workspace", async () => {
    const other = await kernelWorkspace();
    const c = await make(other, [rent(other.id.ada)]);
    await tick(k, "2027-05-02");
    expect(await rows(other, c)).toEqual([]);
  });
});

describe("the preview before Apply (m32-a)", () => {
  it("reads the schedule, the next date, the row it adds and the dates it would have added, adding nothing", async () => {
    const kk = await kernelWorkspace();
    const c = await make(kk, []);
    const rule = rent(kk.id.ada);
    const now = new Date("2026-11-08T18:00:00Z");
    const p = await kk.as("ada", (tx, cx) => previewRepeatRule(tx, cx, c, rule), now);
    expect(p).toEqual({
      schedule: "Every month on the 1st, from Nov 8, 2026",
      next: "Dec 1, 2026",
      columns: ["What for", "Who", "Date", "Amount", "Category", "Paid with"],
      values: [{ text: "Office rent" }, { text: "Ada Admin", person: true }, { text: "The 1st" }, { text: "$2,400" }, { text: "Office" }, { text: "Company card" }],
      past: 3,
      pastWords: "Sep 1, Oct 1 and Nov 1, 2026",
    });
    const replay = await kk.as("ada", (tx, cx) => previewRule(tx, cx, c, rule), now);
    expect(replay.summary).toBe("On your last 90 days, this rule would have added 3 rows.");
    expect(replay.items.map((i) => [i.on, i.did])).toEqual([["2026-09-01", ["add Office rent"]], ["2026-10-01", ["add Office rent"]], ["2026-11-01", ["add Office rent"]]]);
    expect(await rows(kk, c)).toEqual([]);
    await expect(kk.as("maya", (tx, cx) => previewRepeatRule(tx, cx, c, rule), now)).rejects.toThrow();
  });
});

describe("refused when saved", () => {
  const ADA = "11111111-1111-4111-8111-111111111111";
  const people = new Set([ADA]);
  const check = (rule: Rule) => {
    const r = validateFile(spend([rule], ADA), { people });
    return r.ok ? [] : r.errors;
  };
  const base = rent(ADA);
  const withMap = (map: Record<string, unknown>) => ({ ...base, actions: [{ kind: "create_row_in" as const, target: { sheet: "expenses" }, map: map as never }] });
  const { who: _who, amount: _amount, ...rest } = (base.actions[0] as { map: Record<string, unknown> }).map;

  it("accepts the office rent", () => expect(check(base)).toEqual([]));

  it("a row it can't add: a required column, or whoever adds it, left empty", () => {
    expect(check(withMap({ ...rest, who: ADA }))).toEqual([expect.stringContaining("leaves Amount empty, and Expenses needs it.")]);
    expect(check(withMap({ ...rest, amount: 1 }))).toEqual([expect.stringContaining("leaves Who empty; a repeating rule adds rows for nobody, so say who.")]);
  });

  it("a value read from a row it doesn't have, a condition, another sheet, a missing schedule", () => {
    expect(check(withMap({ ...rest, who: ADA, amount: { col: "amount" } }))).toEqual([expect.stringContaining("fills Amount from a row, but a repeating rule has no row; give the value itself.")]);
    expect(check({ ...base, condition: true })).toEqual([expect.stringContaining("has a condition")]);
    expect(check({ ...base, actions: [{ kind: "notify", people: [ADA], message: "Rent" }] })).toEqual([expect.stringContaining("all it can do is add rows to Expenses.")]);
    expect(check({ ...base, trigger: { kind: "repeats", sheet: "expenses" } })).toEqual([expect.stringContaining("doesn't say how often.")]);
    expect(check({ ...base, trigger: { kind: "repeats", sheet: "expenses", every: { unit: "year", month: 2, day: 30 } } })).toEqual([expect.stringContaining("a day that month doesn't have.")]);
    expect(check({ ...base, trigger: { ...base.trigger, starts: "2027-01-01", ends: "2026-12-01" } })).toEqual([expect.stringContaining("ends before it starts.")]);
  });

  it("a person who isn't in People, a choice the column doesn't have", () => {
    expect(check(withMap({ ...rest, who: "22222222-2222-4222-8222-222222222222", amount: 1 }))).toEqual([expect.stringContaining("someone who isn't in People.")]);
    expect(check(withMap({ ...rest, who: ADA, amount: 1, category: "rent" }))).toEqual([expect.stringContaining("a choice it doesn't have.")]);
  });

  it("a schedule on any other rule", () => {
    expect(check({ ...base, trigger: { kind: "row_created", sheet: "expenses", every: { unit: "month", day: 1 } } })).toContain("Rule “Every month on the 1st, add the office rent to Expenses: $2,400, Office, paid with the company card, for Ada.”: has a schedule, which only a repeating rule can.");
  });
});
