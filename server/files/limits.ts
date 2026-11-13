// What Bike accepts as an upload, in one place: 25 MB, and these kinds of file only.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const ALLOWED: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  md: "text/markdown",
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

// The file's type from its name, or why it can't be uploaded.
export function checkUpload(name: string, size: number): { ok: true; mime: string } | { ok: false; reason: string } {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const mime = ALLOWED[ext];
  if (!mime) return { ok: false, reason: "Bike takes PDF, Word, Markdown, Excel, CSV, zip, PNG and JPG files." };
  if (size > MAX_UPLOAD_BYTES) return { ok: false, reason: "That file is over 25 MB." };
  if (size === 0) return { ok: false, reason: "That file is empty." };
  return { ok: true, mime };
}
