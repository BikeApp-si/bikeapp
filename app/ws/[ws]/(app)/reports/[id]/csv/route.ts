import { asPage } from "@/server/auth/kernel-call";
import { download, orNotFound } from "@/server/auth/download";
import { reportCsv, reportForDownload } from "@/server/kernel/report/download";

// 11i: a report's table as CSV, for the admin whose chat it is (checked in the kernel and by RLS).
export async function GET(_req: Request, { params }: { params: Promise<{ ws: string; id: string }> }) {
  const { ws, id } = await params;
  return orNotFound(async () => {
    const r = await asPage(ws, (tx, ctx) => reportForDownload(tx, ctx, id, "csv"));
    return download({ name: `${r.view.title}.csv`, mime: "text/csv; charset=utf-8", body: new TextEncoder().encode(reportCsv(r.view)) });
  });
}
