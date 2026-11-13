// Whether a file's first bytes are the kind its name says: a PDF starts %PDF-, a PNG and a JPG with their
// signatures, docx, xlsx and zip are zip archives, and a CSV and a Markdown file are text. A file named for one kind and holding
// another is refused before it is kept or read.

const starts = (body: Uint8Array, sig: number[]) => sig.every((b, i) => body[i] === b);
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPG = [0xff, 0xd8, 0xff];
const ZIP = [0x50, 0x4b, 0x03, 0x04]; // PK..

function isText(body: Uint8Array): boolean {
  const head = body.subarray(0, 64 * 1024);
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head.length === body.length ? head : head.subarray(0, lastBoundary(head)));
    return true;
  } catch {
    // Spreadsheet exports in Windows-1252 are text too: no control bytes beyond tab, line and page breaks.
    return head.every((b) => b >= 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0c);
  }
}
// Cut at the start of a UTF-8 character, so a sample that ends mid-character still decodes.
function lastBoundary(head: Uint8Array): number {
  let i = head.length;
  while (i > 0 && (head[i - 1]! & 0xc0) === 0x80) i--;
  return i > 0 && head[i - 1]! >= 0xc0 ? i - 1 : head.length;
}

export function looksLike(ext: string, body: Uint8Array): boolean {
  switch (ext) {
    case "pdf":
      return starts(body, PDF);
    case "png":
      return starts(body, PNG);
    case "jpg":
    case "jpeg":
      return starts(body, JPG);
    case "docx":
    case "xlsx":
    case "zip":
      return starts(body, ZIP);
    case "csv":
    case "md":
      return isText(body);
    default:
      return false;
  }
}
