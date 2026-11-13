import { asPage } from "@/server/auth/kernel-call";
import { download, orNotFound } from "@/server/auth/download";
import { reportForDownload } from "@/server/kernel/report/download";
import { reportHtml, reportPdf } from "@/server/report/pdf";

// 11h: a report as a PDF, printed on the server from the panel's layout.
export async function GET(_req: Request, { params }: { params: Promise<{ ws: string; id: string }> }) {
  const { ws, id } = await params;
  return orNotFound(async () => {
    const r = await asPage(ws, (tx, ctx) => reportForDownload(tx, ctx, id, "pdf"));
    const html = await reportHtml(r.view, { by: r.by, workspace: r.workspace, address: `${r.subdomain}.${process.env.ROOT_HOST ?? "bikeapp.si"}` });
    return download({ name: `${r.view.title}.pdf`, mime: "application/pdf", body: await reportPdf(html) });
  });
}
