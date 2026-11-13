import { describe, expect, it } from "vitest";
import { contractsFile } from "./fixtures";
import type { Column, ColumnType } from "./schema/file";
import { checkValue, checkValues } from "./values";

const ID = "8b5f2a7e-3c1d-4e6f-9a0b-1c2d3e4f5a6b";
const col = (type: ColumnType, extra: Partial<Column> = {}): Column => ({ id: "x", name: "Field", type, ...extra });

// For every column type: a value that passes (and how it is stored), and one that is refused.
const CASES: [ColumnType, Partial<Column>, unknown, unknown, unknown][] = [
  ["text", {}, "  Northwind ", "Northwind", 42],
  ["long_text", {}, "Family trip,\nback on Jan 4", "Family trip,\nback on Jan 4", "x".repeat(10_001)],
  ["number", { min: 1, max: 4 }, 3, 3, 5],
  ["money", {}, 3_840_000, 3_840_000, 38_400.5],
  ["money_range", {}, { from: 15_000_000, to: 18_000_000 }, { from: 15_000_000, to: 18_000_000 }, { from: 2, to: 1 }],
  ["percent", {}, 87.5, 87.5, "87%"],
  ["date", {}, "2026-11-14", "2026-11-14", "2026-02-30"],
  ["datetime", {}, "2026-10-27T15:30:00-05:00", "2026-10-27T20:30:00.000Z", "tomorrow at 3"],
  ["days", {}, 30, 30, 1.5],
  ["person", {}, ID.toUpperCase(), ID, "Krishna"],
  ["email", {}, " Billing@Northwind.com ", "billing@northwind.com", "billing@"],
  ["phone", {}, "+1 (512) 555-0134", "+1 (512) 555-0134", "call me"],
  ["url", {}, "fernwood.dev", "fernwood.dev", "not a site"],
  ["file", {}, ID, ID, "contract.pdf"],
  ["choice", { options: [{ id: "vacation", name: "Vacation" }, { id: "sick", name: "Sick" }] }, "sick", "sick", "Holiday"],
  ["link", {}, ID, ID, 7],
];

describe("checkValue, every column type", () => {
  it.each(CASES)("%s keeps a good value", (type, extra, good, stored) => {
    expect(checkValue(col(type, extra), good)).toEqual({ ok: true, value: stored });
  });

  it.each(CASES)("%s refuses a bad one", (type, extra, _good, _stored, badValue) => {
    const r = checkValue(col(type, extra), badValue);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^Field /);
  });

  it("step: one of the sheet's steps", () => {
    const sheet = contractsFile().sheets[0]!;
    const status = sheet.columns.find((c) => c.type === "step")!;
    expect(checkValue(status, "signed", sheet)).toEqual({ ok: true, value: "signed" });
    expect(checkValue(status, "lost", sheet).ok).toBe(false);
  });

  it("computed: never filled in", () => {
    expect(checkValue(col("computed"), 5)).toEqual({ ok: false, error: "Field is worked out by Bike and can't be filled in." });
  });

  it("an empty value is stored as nothing", () => {
    for (const [type, extra] of CASES) expect(checkValue(col(type, extra), "  ")).toEqual({ ok: true, value: null });
  });
});

describe("checkValues, a whole row", () => {
  const sheet = contractsFile().sheets[0]!;
  const opts = { creatorId: ID, today: "2026-10-27" };

  it("fills defaults: a value, whoever adds it, the first step, Start + 1 year", () => {
    const r = checkValues(sheet, { customer: "Kova", value: 1_080_000, start: "2026-03-10" }, opts);
    expect(r).toEqual({
      ok: true,
      data: { customer: "Kova", value: 1_080_000, start: "2026-03-10", renews: "2027-03-10", notice: 30, owner: ID, status: "draft" },
    });
  });

  it("keeps a value given in place of a default", () => {
    const r = checkValues(sheet, { customer: "Kova", value: 1, start: "2026-03-10", renews: "2027-03-09", notice: 60 }, opts);
    expect(r.ok && r.data).toMatchObject({ renews: "2027-03-09", notice: 60 });
  });

  it("refuses missing required fields, unknown columns, computed columns and steps", () => {
    const r = checkValues(sheet, { start: "2026-03-10", colour: "red", days_left: 3, status: "active" }, opts);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors).toEqual([
        "Contracts has no column “colour”.",
        "Days left is worked out by Bike and can't be filled in.",
        "Status changes by moving the row to a step.",
        "Customer is required.",
        "Value a year is required.",
      ]);
  });

  it("an edit checks what it changes and still needs every required field", () => {
    const existing = { customer: "Kova", value: 1_080_000, status: "active" };
    expect(checkValues(sheet, { value: 1_200_000 }, { ...opts, existing })).toEqual({ ok: true, data: { ...existing, value: 1_200_000 } });
    const cleared = checkValues(sheet, { customer: "" }, { ...opts, existing });
    expect(cleared.ok || cleared.errors).toEqual(["Customer is required."]);
  });
});
