import { strFromU8, unzipSync } from "fflate";
import { MAX_UPLOAD_BYTES } from "./limits";
import { readPdf } from "./read";
import { MAX_SHEET_ROWS, MAX_UNZIPPED_BYTES, readSpreadsheet, SheetError, unzippedSize } from "./sheet-reader";

// What Bike reads from the files a build starts from (4a): a write-up and policies as text, page by page, and
// an export's tables. Everything read here is data for the AI, never instructions; text that reads like an
// instruction to Bike is flagged (flags below) and stays data.

export type TextDoc = { kind: "text"; name: string; pages: number | null; text: string };
export type TableDoc = { kind: "table"; name: string; from: string | null; table: string[][] }; // from: the zip it came in
export type ReadFile = { name: string; detail: string; docs: (TextDoc | TableDoc)[] };

// An export's files together: no more rows than this across a zip.
export const MAX_EXPORT_ROWS = 20_000;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const ext = (name: string) => name.toLowerCase().split(".").pop() ?? "";

// One uploaded file, read for a build. Throws SheetError with a plain reason for a file Bike can't read.
export async function readForBuild(name: string, body: Uint8Array): Promise<ReadFile> {
  if (body.byteLength > MAX_UPLOAD_BYTES) throw new SheetError("That file is over 25 MB.");
  switch (ext(name)) {
    case "pdf": {
      const { pages, text } = await readPdf(body);
      return { name, detail: plural(pages, "page"), docs: [{ kind: "text", name, pages, text }] };
    }
    case "docx": {
      const doc = readDocx(name, body);
      return { name, detail: doc.pages ? plural(doc.pages, "page") : "Word", docs: [doc] };
    }
    case "md": {
      const text = new TextDecoder().decode(body);
      return { name, detail: "Markdown", docs: [{ kind: "text", name, pages: null, text }] };
    }
    case "csv":
    case "xlsx": {
      const table = await readSpreadsheet(name, body);
      return { name, detail: plural(table.length - 1, "row"), docs: [{ kind: "table", name, from: null, table }] };
    }
    case "zip": {
      const tables = await readZip(name, body);
      const rows = tables.reduce((n, t) => n + t.table.length - 1, 0);
      return { name, detail: `${plural(tables.length, "file")} · ${plural(rows, "row")}`, docs: tables };
    }
    default:
      throw new SheetError("Bike reads PDF, Word, Markdown, Excel, CSV and zip files for a build.");
  }
}

function unzipGuarded(body: Uint8Array, what: string, keep: (name: string) => boolean): Record<string, Uint8Array> {
  let size: number;
  try {
    size = unzippedSize(body);
  } catch {
    throw new SheetError(`That file isn't a ${what} Bike can read.`);
  }
  if (size > MAX_UNZIPPED_BYTES) throw new SheetError("That file is too large to read once unzipped.");
  try {
    return unzipSync(body, { filter: (f) => keep(f.name) });
  } catch {
    throw new SheetError(`That file isn't a ${what} Bike can read.`);
  }
}

// An export: only the CSV and Excel files inside it, each through the spreadsheet guard. Folders and other
// files (images, the zip's own notes) are left out.
async function readZip(name: string, body: Uint8Array): Promise<TableDoc[]> {
  const isTable = (n: string) => !n.startsWith("__MACOSX/") && !n.split("/").pop()!.startsWith(".") && /\.(csv|xlsx)$/i.test(n);
  const files = unzipGuarded(body, "zip file", isTable);
  const out: TableDoc[] = [];
  let rows = 0;
  for (const path of Object.keys(files).sort()) {
    const inner = path.split("/").pop()!;
    const table = await readSpreadsheet(inner, files[path]!);
    rows += table.length - 1;
    if (rows > MAX_EXPORT_ROWS) throw new SheetError(`That export has more than ${MAX_EXPORT_ROWS.toLocaleString("en-US")} rows.`);
    out.push({ kind: "table", name: inner, from: name, table });
  }
  if (!out.length) throw new SheetError("That zip file has no CSV or Excel files in it.");
  return out;
}

// A Word file's text, paragraph by paragraph, marked by page where Word recorded its page breaks; its page
// count from the file's own properties.
export function readDocx(name: string, body: Uint8Array): TextDoc {
  const files = unzipGuarded(body, "Word file", (n) => n === "word/document.xml" || n === "docProps/app.xml");
  const xml = files["word/document.xml"];
  if (!xml) throw new SheetError("That file isn't a Word file Bike can read.");
  const app = files["docProps/app.xml"] ? strFromU8(files["docProps/app.xml"]) : "";
  const stated = Number(/<Pages>(\d+)<\/Pages>/.exec(app)?.[1] ?? 0) || null;

  let page = 1;
  const lines: string[] = ["[Page 1]"];
  for (const para of strFromU8(xml).split(/<\/w:p>/)) {
    const breaks = (para.match(/<w:lastRenderedPageBreak\/>|<w:br [^>]*w:type="page"[^>]*\/>/g) ?? []).length;
    for (let i = 0; i < breaks; i++) lines.push("", `[Page ${++page}]`);
    const text = [...para.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)].map((m) => (m[1] === undefined ? "\t" : unescapeXml(m[1]))).join("");
    if (text.trim()) lines.push(text);
  }
  return { kind: "text", name, pages: stated ?? page, text: lines.join("\n") };
}

const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// ── Text that reads like an instruction to Bike ──

export type Flag = { file: string; page: number | null; excerpt: string };

const INSTRUCTION = [
  /\bignore (?:all |any |the )?(?:previous|prior|above|earlier|other) (?:instructions|rules|prompts?)\b/i,
  /\bdisregard (?:all |any |the )?(?:previous|prior|above|earlier) /i,
  /\b(?:you are|act as) (?:now )?(?:an? |the )?(?:ai|assistant|language model|chatbot|bike)\b/i,
  /\bsystem prompt\b/i,
  /\b(?:dear|note to|attention|instructions? (?:for|to)) (?:the )?(?:ai|assistant|model|bike|chatbot)\b/i,
  /\b(?:give|grant|make) (?:\w+ ){0,3}(?:admin|full access|access to everything)\b/i,
];

// Lines in a text document that match a fixed pattern, one per page (the longest), with its page. The
// prompts flag more (their own `flags`); both are recorded, and neither is ever followed.
export function flagInstructions(doc: TextDoc): Flag[] {
  const out: Flag[] = [];
  let page: number | null = null;
  for (const line of doc.text.split("\n")) {
    const marker = /^\[Page (\d+)\]$/.exec(line.trim());
    if (marker) {
      page = Number(marker[1]);
      continue;
    }
    if (!INSTRUCTION.some((r) => r.test(line))) continue;
    const flag = { file: doc.name, page, excerpt: line.trim().slice(0, 160) };
    const same = out.findIndex((f) => f.page === page);
    if (same < 0) out.push(flag);
    else if (flag.excerpt.length > out[same]!.excerpt.length) out[same] = flag;
  }
  return out;
}

export { MAX_SHEET_ROWS };
