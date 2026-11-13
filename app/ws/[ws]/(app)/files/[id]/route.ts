import { asPage } from "@/server/auth/kernel-call";
import { download, orNotFound } from "@/server/auth/download";
import { openUpload } from "@/server/kernel/uploads";

// Opens an uploaded file for whoever may see it (the row it is in, or the person who uploaded it).
export async function GET(_req: Request, { params }: { params: Promise<{ ws: string; id: string }> }) {
  const { ws, id } = await params;
  return orNotFound(async () => {
    const file = await asPage(ws, (tx, ctx) => openUpload(tx, ctx, id));
    // PDFs and images open in the browser; Word, Excel and CSV download.
    return download(file, file.mime === "application/pdf" || file.mime.startsWith("image/"));
  });
}
