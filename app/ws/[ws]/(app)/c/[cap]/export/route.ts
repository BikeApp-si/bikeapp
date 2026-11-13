import { asPage } from "@/server/auth/kernel-call";
import { download, orNotFound } from "@/server/auth/download";
import { exportCapability } from "@/server/kernel/export";

// Export data as CSV (9c): the sheets the person can see, zipped when there are several. Logged as data.exported.
export async function GET(_req: Request, { params }: { params: Promise<{ ws: string; cap: string }> }) {
  const { ws, cap } = await params;
  return orNotFound(async () => download(await asPage(ws, (tx, ctx) => exportCapability(tx, ctx, cap))));
}
