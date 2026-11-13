"use server";

import { asAction } from "@/server/auth/kernel-call";
import { listAudit, type AuditFilter } from "@/server/kernel/audit";

// A part of the Audit log, newest first, with the counts for "N of total events".
export async function loadAudit(filter: AuditFilter, offset: number) {
  return asAction(async (tx, ctx) => listAudit(tx, ctx, { ...filter, limit: 100, offset }));
}
