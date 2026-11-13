import { ScrollText } from "lucide-react";
import { connection } from "next/server";
import { AuditTable } from "@/components/audit/audit-table";
import { asPage } from "@/server/auth/kernel-call";
import { currentWorkspace, requireAdmin } from "@/server/auth/current";
import { auditPeople, listAudit } from "@/server/kernel/audit";
import { capabilityNames } from "@/server/kernel/capabilities";

// 9a, admins only (the kernel refuses everyone else too).
export default async function AuditPage({ params }: { params: Promise<{ ws: string }> }) {
  await connection();
  const wsParam = (await params).ws;
  const ws = await currentWorkspace(wsParam);
  await requireAdmin(ws);
  const data = await asPage(wsParam, async (tx, ctx) => ({
    first: await listAudit(tx, ctx, { limit: 100 }),
    capabilities: await capabilityNames(tx),
    people: await auditPeople(tx, ctx),
  }));
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <AuditTable {...data} />
    </div>
  );
}
