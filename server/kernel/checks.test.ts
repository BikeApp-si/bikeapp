import { beforeAll, describe, expect, it } from "vitest";
import { auditEntries, rows, waits } from "@/db/schema";
import { kernelWorkspace } from "@/tests/kernel";
import type { CapabilityFile } from "./schema/file";
import { createRow, getRow, importRows, listRows, previewAdd } from "./rows";

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let cap: string;
const NOW = new Date("2026-10-27T15:00:00Z");
const LEFT = { lookup: { sheet: "balances", where: "who", is: "who", value: "left" } };

// Requests checked against what is left in the person's balance, with the balance after shown when read.
const file = (): CapabilityFile => ({
  name: "Time off",
  icon: "calendar-days",
  sheets: [
    {
      id: "requests",
      name: "Requests",
      kind: "list",
      titleColumn: "who",
      columns: [
        { id: "who", name: "Who", type: "person", default: { kind: "creator" } },
        { id: "from", name: "From", type: "date", required: true },
        { id: "to", name: "To", type: "date", required: true },
        { id: "days", name: "Days", type: "computed", result: "number", expr: { op: "add", args: [{ op: "sub", args: [{ col: "to" }, { col: "from" }] }, 1] } },
        { id: "balance_after", name: "Balance after", type: "computed", result: "days", expr: { op: "sub", args: [LEFT, { col: "days" }] } },
        { id: "status", name: "Status", type: "step" },
      ],
      steps: [{ id: "submitted", name: "Submitted", start: true }, { id: "taken", name: "Taken", end: "final" }],
      checks: [{ id: "balance", name: "Within your balance", condition: { op: "or", args: [{ op: "empty", args: [LEFT] }, { op: "lte", args: [{ col: "days" }, LEFT] }] } }],
    },
    {
      id: "balances",
      name: "Balances",
      kind: "list",
      titleColumn: "who",
      columns: [
        { id: "who", name: "Who", type: "person" },
        { id: "allowance", name: "Days a year", type: "days" },
        { id: "used", name: "Used", type: "days" },
        { id: "left", name: "Left", type: "computed", result: "days", expr: { op: "sub", args: [{ col: "allowance" }, { col: "used" }] } },
      ],
    },
  ],
  roles: [{ id: "admins", name: "Admins", members: { kind: "people", people: [k.id.ada] }, can: ["see", "add"], scope: "all" }, { id: "everyone", name: "Everyone", members: { kind: "everyone" }, can: ["see", "add"], scope: "own", scopeColumns: { requests: { column: "who" }, balances: { column: "who" } } }],
  rules: [
    {
      id: "to_manager",
      text: "Requests go to the person’s manager.",
      reading: { when: "w", then: "t" },
      trigger: { kind: "enters_step", sheet: "requests", step: "submitted" },
      actions: [{ kind: "ask_person", managerOf: "who", step: "submitted" }],
      enabled: true,
    },
  ],
  later: [],
});

beforeAll(async () => {
  k = await kernelWorkspace();
  cap = await k.create(file());
  await k.as("ada", (tx, c) => importRows(tx, c, cap, "balances", [{ values: { who: k.id.maya, allowance: 20, used: 8 } }], { source: "b.csv" }), NOW);
});

const ask = (from: string, to: string) => k.as("maya", (tx, c) => createRow(tx, c, cap, "requests", { values: { from, to } }), NOW);

describe("checks on a new row", () => {
  it("lets a request within the balance through, and shows the balance after it when read", async () => {
    const { id } = await ask("2026-11-23", "2026-11-25");
    expect((await k.as("maya", (tx, c) => getRow(tx, c, id), NOW)).data).toMatchObject({ days: 3, balance_after: 9 });
    expect((await k.as("maya", (tx, c) => listRows(tx, c, cap, "requests"), NOW))[0]!.data.balance_after).toBe(9);
  });

  it("refuses one over the balance, with the check's name in plain words", async () => {
    await expect(ask("2026-12-01", "2026-12-31")).rejects.toThrow(/^Within your balance: it needs .*Days at most Left in Balances for the same Who\.$/);
  });

  it("lets anyone without a balance row through", async () => {
    await expect(k.as("omar", (tx, c) => createRow(tx, c, cap, "requests", { values: { from: "2026-12-01", to: "2026-12-31" } }), NOW)).resolves.toBeTruthy();
  });
});

describe("previewAdd (8f, 8g)", () => {
  it("says who a new row would wait on and how the checks come out, and keeps nothing", async () => {
    const counts = () => k.as("ada", async (tx) => [await tx.$count(rows), await tx.$count(waits), await tx.$count(auditEntries)]);
    const before = await counts();
    const ok = await k.as("maya", (tx, c) => previewAdd(tx, c, cap, "requests", { from: "2026-11-23", to: "2026-11-25" }), NOW);
    expect(ok).toEqual({ goesTo: [{ id: k.id.priya, name: "Priya Nair", why: "your manager" }], checks: [{ name: "Within your balance", ok: true, reason: null }], problems: [] });
    const over = await k.as("maya", (tx, c) => previewAdd(tx, c, cap, "requests", { from: "2026-12-01", to: "2026-12-31" }), NOW);
    expect(over.checks[0]).toMatchObject({ ok: false });
    const missing = await k.as("maya", (tx, c) => previewAdd(tx, c, cap, "requests", { from: "2026-12-01" }), NOW);
    expect(missing.problems.join()).toMatch(/To/);
    expect(await counts()).toEqual(before);
  });
});
