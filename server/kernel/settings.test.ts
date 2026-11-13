import { beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { auditEntries } from "@/db/schema";
import { kernelWorkspace } from "@/tests/kernel";
import { addAdmin, getSettings, removeAdmin, updateSettings } from "./settings";
import { saveUpload } from "./uploads";

let k: Awaited<ReturnType<typeof kernelWorkspace>>;

beforeAll(async () => {
  k = await kernelWorkspace();
});

const lastEvent = (event: string) =>
  k.as("ada", (tx) => tx.select().from(auditEntries).where(eq(auditEntries.event, event)).orderBy(desc(auditEntries.seq)).limit(1)).then((r) => r[0]);

describe("settings", () => {
  it("shows the owner first and changes the name, with an Audit entry", async () => {
    const s = await k.as("ada", (tx, c) => getSettings(tx, c));
    expect(s.admins).toEqual([{ id: k.id.ada, name: "Ada Admin", title: null, owner: true }]);
    await k.as("ada", (tx, c) => updateSettings(tx, c, { name: "  Fernwood Labs " }));
    expect((await k.as("ada", (tx, c) => getSettings(tx, c))).name).toBe("Fernwood Labs");
    expect((await lastEvent("settings.updated"))?.details).toMatchObject({ name: { to: "Fernwood Labs" } });
    await expect(k.as("ada", (tx, c) => updateSettings(tx, c, { name: " " }))).rejects.toThrow(/needs a name/);
  });

  it("takes an uploaded image as the logo, never a PDF", async () => {
    const png = await k.as("ada", (tx, c) => saveUpload(tx, c, { name: "logo.png", body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]) }));
    await k.as("ada", (tx, c) => updateSettings(tx, c, { logoUploadId: png.id }));
    expect((await k.as("ada", (tx, c) => getSettings(tx, c))).logoUploadId).toBe(png.id);
    const pdf = await k.as("ada", (tx, c) => saveUpload(tx, c, { name: "logo.pdf", body: new TextEncoder().encode("%PDF-1.7") }));
    await expect(k.as("ada", (tx, c) => updateSettings(tx, c, { logoUploadId: pdf.id }))).rejects.toThrow(/PNG or JPG/);
  });

  it("adds and removes admins; the owner and the last admin stay", async () => {
    await k.as("ada", (tx, c) => addAdmin(tx, c, k.id.rita));
    expect((await lastEvent("admin.added"))?.details).toEqual({ person: k.email("rita") });
    expect((await k.as("ada", (tx, c) => getSettings(tx, c))).admins.map((a) => a.id)).toEqual([k.id.ada, k.id.rita]);
    await expect(k.as("rita", (tx, c) => removeAdmin(tx, c, k.id.ada))).rejects.toThrow(/owner stays an admin/);
    await k.as("rita", (tx, c) => removeAdmin(tx, c, k.id.rita));
    expect((await lastEvent("admin.removed"))?.details).toEqual({ person: k.email("rita") });
  });

  it("keeps the website, address, currency, numbers, dates and year (M26), in words in the Audit log", async () => {
    const before = await k.as("ada", (tx, c) => getSettings(tx, c));
    expect(before).toMatchObject({ website: "", currency: "USD", numberGrouping: "standard", dateStyle: "mdy", fiscalYearStart: 1 });
    // Choosing what an empty field already reads as changes nothing.
    expect(await k.as("ada", (tx, c) => updateSettings(tx, c, { numberGrouping: "standard", dateStyle: "mdy", currency: "USD", fiscalYearStart: 1 }))).toEqual({ changed: false });
    await k.as("ada", (tx, c) =>
      updateSettings(tx, c, { website: "https://www.neem.in/", street: "12 MG Road", city: "Bengaluru", addressRegion: "KA", country: "IN", currency: "INR", numberGrouping: "indian", dateStyle: "dmy", fiscalYearStart: 4 }),
    );
    expect(await k.as("ada", (tx, c) => getSettings(tx, c))).toMatchObject({
      website: "neem.in", street: "12 MG Road", city: "Bengaluru", addressRegion: "KA", country: "IN",
      currency: "INR", numberGrouping: "indian", dateStyle: "dmy", fiscalYearStart: 4,
    });
    expect((await lastEvent("settings.updated"))?.details).toMatchObject({
      currency: { from: "USD", to: "INR" },
      numbers: { from: "1,234,567", to: "12,34,567" },
      dates: { from: "Nov 14, 2026", to: "14 Nov 2026" },
      yearStarts: { from: "January", to: "April" },
      website: { from: "", to: "neem.in" },
    });
    await expect(k.as("ada", (tx, c) => updateSettings(tx, c, { currency: "JPY" }))).rejects.toThrow(/currency from the list/);
    await expect(k.as("ada", (tx, c) => updateSettings(tx, c, { country: "XX" }))).rejects.toThrow(/country from the list/);
    await expect(k.as("ada", (tx, c) => updateSettings(tx, c, { website: "not a site" }))).rejects.toThrow(/web address/);
    await expect(k.as("ada", (tx, c) => updateSettings(tx, c, { fiscalYearStart: 13 }))).rejects.toThrow(/month the year starts/);
  });

  it("refuses everyone who isn't an admin, in the kernel", async () => {
    await expect(k.as("maya", (tx, c) => getSettings(tx, c))).rejects.toThrow(/Only admins/);
    await expect(k.as("maya", (tx, c) => addAdmin(tx, c, k.id.maya))).rejects.toThrow(/Only admins/);
    await expect(k.as("maya", (tx, c) => updateSettings(tx, c, { name: "Mine" }))).rejects.toThrow(/Only admins/);
    await expect(k.as("maya", (tx, c) => updateSettings(tx, c, { currency: "EUR" }))).rejects.toThrow(/Only admins/);
  });
});
