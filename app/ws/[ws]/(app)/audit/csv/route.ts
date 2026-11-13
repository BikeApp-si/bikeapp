import { asPage } from "@/server/auth/kernel-call";
import { download, orNotFound } from "@/server/auth/download";
import { auditCsv } from "@/server/kernel/audit";

// Download CSV on 9a: the entries the search and filters show, admins only (checked in the kernel).
export async function GET(req: Request, { params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const q = new URL(req.url).searchParams;
  const filter = { search: q.get("search") ?? undefined, capabilityId: q.get("capability") ?? undefined, who: q.get("who") ?? undefined };
  return orNotFound(async () => {
    const csv = await asPage(ws, (tx, ctx) => auditCsv(tx, ctx, filter));
    return download({ name: "audit-log.csv", mime: "text/csv", body: new TextEncoder().encode(csv) });
  });
}
