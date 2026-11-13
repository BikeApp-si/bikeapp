import { extractText } from "unpdf";
import { parseCsv } from "@/lib/csv";

// What Bike reads from an uploaded file for a chat: a PDF's text page by page (marked, so a plan can say
// "policy p. 3"), or a CSV's size for its chip. The text is data for the AI, never instructions.

export async function readPdf(body: Uint8Array): Promise<{ pages: number; text: string }> {
  const { totalPages, text } = await extractText(new Uint8Array(body), { mergePages: false });
  return { pages: totalPages, text: text.map((t, i) => `[Page ${i + 1}]\n${t.trim()}`).join("\n\n") };
}

export function csvSize(body: Uint8Array): { rows: number; columns: number } {
  const [header = [], ...rows] = parseCsv(new TextDecoder().decode(body));
  return { rows: rows.length, columns: header.length };
}

// The line under a file's name in the chat: "CSV · 12 rows · 9 columns" (5g), "38 pages" for a PDF or Word file
// (4a, 5j), "Markdown" for a .md file, and "6 files · 3,214 rows" for an export.
export async function fileDetail(name: string, body: Uint8Array): Promise<string> {
  if (/\.(docx|md|xlsx|zip)$/i.test(name)) {
    const { readForBuild } = await import("./documents");
    return (await readForBuild(name, body).catch(() => null))?.detail ?? name.split(".").pop()!.toUpperCase();
  }
  if (/\.csv$/i.test(name)) {
    const { rows, columns } = csvSize(body);
    return `CSV · ${rows} ${rows === 1 ? "row" : "rows"} · ${columns} ${columns === 1 ? "column" : "columns"}`;
  }
  if (/\.pdf$/i.test(name)) {
    const { pages } = await readPdf(body);
    return `${pages} ${pages === 1 ? "page" : "pages"}`;
  }
  return name.split(".").pop()!.toUpperCase();
}
