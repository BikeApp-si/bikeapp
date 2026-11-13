import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditEntries } from "@/db/schema";
import { kernelWorkspace } from "@/tests/kernel";
import { listHolidays, saveHolidays } from "./holidays";

// Holidays a build finds in the policies: kept with their page, by an admin, once per date, in their own
// workspace only.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let other: Awaited<ReturnType<typeof kernelWorkspace>>;
const FROM = { file: "Fernwood policies.pdf", page: 13 };

beforeAll(async () => {
  k = await kernelWorkspace();
  other = await kernelWorkspace();
});

describe("holidays from the policies", () => {
  it("are kept with their page, once per date, with one Audit entry", async () => {
    const added = await k.as("ada", (tx, c) => saveHolidays(tx, c, [{ date: "2026-12-25", name: "Christmas Day", ...FROM }, { date: "2026-01-01", name: "New Year's Day", ...FROM }]));
    expect(added).toBe(2);
    expect(await k.as("ada", (tx, c) => saveHolidays(tx, c, [{ date: "2026-12-25", name: "Christmas", ...FROM }]))).toBe(0);
    expect(await k.as("maya", (tx) => listHolidays(tx))).toEqual([
      { date: "2026-01-01", name: "New Year's Day", ...FROM },
      { date: "2026-12-25", name: "Christmas Day", ...FROM },
    ]);
    const entries = await k.as("ada", (tx) => tx.select().from(auditEntries).where(eq(auditEntries.event, "holidays.saved")));
    expect(entries.map((e) => e.details)).toEqual([{ holidays: 2, files: ["Fernwood policies.pdf"] }]);
  });

  it("only an admin keeps them, and only real dates", async () => {
    await expect(k.as("maya", (tx, c) => saveHolidays(tx, c, [{ date: "2026-07-04", name: "Independence Day", ...FROM }]))).rejects.toThrow();
    await expect(k.as("ada", (tx, c) => saveHolidays(tx, c, [{ date: "2026-02-30", name: "Nope", ...FROM }]))).rejects.toThrow("isn't a date");
    await expect(k.as("ada", (tx, c) => saveHolidays(tx, c, [{ date: "2026-13-01", name: "Nope", ...FROM }]))).rejects.toThrow("isn't a date");
  });

  it("another workspace sees none of them", async () => {
    expect(await other.as("ada", (tx) => listHolidays(tx))).toEqual([]);
  });
});
