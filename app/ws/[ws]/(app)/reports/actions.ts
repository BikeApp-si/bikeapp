"use server";

import { asAction } from "@/server/auth/kernel-call";
import { savedState, saveForLater, setSchedule, unsave } from "@/server/kernel/report/saved";

// M33: Save and the schedule in the report panel (m33-a, m33-b). The kernel checks the admin asked for the report.

export async function reportSaved(reportId: string) {
  return asAction(async (tx, ctx) => ({ state: await savedState(tx, ctx, reportId) }));
}

export async function saveReportForLater(reportId: string) {
  return asAction(async (tx, ctx) => (await saveForLater(tx, ctx, reportId), { state: await savedState(tx, ctx, reportId) }));
}

export async function unsaveReport(reportId: string) {
  return asAction(async (tx, ctx) => (await unsave(tx, ctx, reportId), { state: await savedState(tx, ctx, reportId) }));
}

export async function scheduleReport(reportId: string, every: unknown | null) {
  return asAction(async (tx, ctx) => (await setSchedule(tx, ctx, reportId, every), { state: await savedState(tx, ctx, reportId) }));
}
