import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { makeXlsx } from "@/tests/files/make-team";
import { MAX_SHEET_ROWS, MAX_UNZIPPED_BYTES, readSpreadsheet, unzippedSize } from "./sheet-reader";

// Rewrites the unzipped size a zip's directory claims for its first file.
function claimSize(zip: Uint8Array, size: number): Uint8Array {
  const out = zip.slice();
  const view = new DataView(out.buffer);
  for (let i = out.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x02014b50) {
      view.setUint32(i + 24, size, true);
      return out;
    }
  }
  throw new Error("no central directory");
}

describe("readSpreadsheet", () => {
  it("reads team.xlsx with start dates as YYYY-MM-DD", async () => {
    const rows = await readSpreadsheet("team.xlsx", readFileSync("tests/files/team.xlsx"));
    expect(rows[0]).toEqual(["Full name", "Work email", "Job title", "Team", "Manager email", "Start date"]);
    expect(rows).toHaveLength(15);
    expect(rows[1]).toEqual(["Wade Wilson", "wade@fernwood.dev", "Founder", "Leadership", "", "2024-01-15"]);
    expect(rows[14]).toEqual(["Lena Ortiz", "lena@fernwood.dev", "Accountant, part time", "Finance", "wade@fernwood.dev", "2024-07-01"]);
  });

  it("reads a CSV the same way", async () => {
    const xlsx = await readSpreadsheet("team.xlsx", readFileSync("tests/files/team.xlsx"));
    const csv = await readSpreadsheet("team.csv", readFileSync("tests/files/team.csv"));
    expect(csv).toEqual(xlsx);
  });

  it("refuses more rows than the cap", async () => {
    const rows = [["Full name"], ...Array.from({ length: MAX_SHEET_ROWS + 1 }, (_, i) => [`P${i}`])];
    await expect(readSpreadsheet("big.xlsx", makeXlsx(rows))).rejects.toThrow("more than 5,000 rows");
    await expect(readSpreadsheet("big.csv", strToU8(rows.map((r) => r[0]).join("\n")))).rejects.toThrow("more than 5,000 rows");
    expect(await readSpreadsheet("ok.csv", strToU8(rows.slice(0, MAX_SHEET_ROWS + 1).map((r) => r[0]).join("\n")))).toHaveLength(MAX_SHEET_ROWS + 1);
  });

  it("refuses a file that claims to unzip past the limit, before unzipping it", async () => {
    const bomb = claimSize(makeXlsx([["a"]]), MAX_UNZIPPED_BYTES + 1);
    expect(unzippedSize(bomb)).toBeGreaterThan(MAX_UNZIPPED_BYTES);
    await expect(readSpreadsheet("bomb.xlsx", bomb)).rejects.toThrow("too large to read once unzipped");
  });

  it("refuses other kinds of file and broken xlsx", async () => {
    await expect(readSpreadsheet("team.pdf", strToU8("x"))).rejects.toThrow("CSV and Excel");
    await expect(readSpreadsheet("team.xlsx", strToU8("not a zip"))).rejects.toThrow("isn't an Excel file");
    await expect(readSpreadsheet("team.xlsx", zipSync({ "a.txt": strToU8("hi") }))).rejects.toThrow("isn't an Excel file");
  });
});
