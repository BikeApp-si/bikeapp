import { unzipSync } from "fflate";
import { readSheet, type SheetData } from "read-excel-file/node";
import { parseCsv } from "@/lib/csv";
import { MAX_UPLOAD_BYTES } from "./limits";

// A spreadsheet (CSV or xlsx) as rows of strings, the first row its header. Guarded so a crafted file
// can't blow up memory: the upload limit, the unzipped size from the zip's own directory (checked before
// anything is unzipped), and a cap on rows. M7 reads documents through the same guard.

export const MAX_SHEET_ROWS = 5000;
export const MAX_UNZIPPED_BYTES = 100 * 1024 * 1024;

export class SheetError extends Error {}

export async function readSpreadsheet(name: string, body: Uint8Array): Promise<string[][]> {
  if (body.byteLength > MAX_UPLOAD_BYTES) throw new SheetError("That file is over 25 MB.");
  const ext = name.toLowerCase().split(".").pop();
  let rows: string[][];
  if (ext === "csv") rows = parseCsv(new TextDecoder().decode(body));
  else if (ext === "xlsx") rows = await readXlsx(body);
  else throw new SheetError("Bike reads CSV and Excel (.xlsx) files here.");
  rows = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length - 1 > MAX_SHEET_ROWS) throw new SheetError(`That file has more than ${MAX_SHEET_ROWS.toLocaleString("en-US")} rows.`);
  return rows;
}

// The sizes the zip says its files unzip to, summed without unzipping any of them.
export function unzippedSize(body: Uint8Array): number {
  let total = 0;
  unzipSync(body, {
    filter: (f) => {
      total += f.originalSize;
      return false;
    },
  });
  return total;
}

async function readXlsx(body: Uint8Array): Promise<string[][]> {
  let size: number;
  try {
    size = unzippedSize(body);
  } catch {
    throw new SheetError("That file isn't an Excel file Bike can read.");
  }
  if (size > MAX_UNZIPPED_BYTES) throw new SheetError("That file is too large to read once unzipped.");
  let data: SheetData;
  try {
    data = await readSheet(Buffer.from(body));
  } catch {
    throw new SheetError("That file isn't an Excel file Bike can read.");
  }
  return data.map((row) => row.map(cellText));
}

// Dates come back as midnight UTC; they're written as YYYY-MM-DD, as the team CSV wants them.
function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}
