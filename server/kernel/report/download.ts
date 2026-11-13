import { workspaces } from "@/db/schema";
import { toCsv } from "@/lib/csv";
import { load, type KernelCtx } from "../context";
import type { Tx } from "../tx";
import { getReport, recordDownload } from "./store";
import { reportView, type ReportView } from "./view";

// A report for download (11h, 11i): the run with its view, who made it, and the workspace it belongs to. Each
// download is an Audit entry (report.downloaded).
export async function reportForDownload(tx: Tx, ctx: KernelCtx, id: string, kind: "csv" | "pdf") {
  const r = await getReport(tx, ctx, id);
  const first = r.firstId ? await getReport(tx, ctx, r.firstId) : undefined;
  const loaded = await load(tx);
  const words = (sheet: string) => [...loaded.files.values()].flatMap((f) => f.file.sheets).find((s) => s.name === sheet)?.row ?? { one: "row", many: "rows" };
  const [ws] = await tx.select({ name: workspaces.name, subdomain: workspaces.subdomain }).from(workspaces);
  await recordDownload(tx, ctx, r, kind);
  return { view: reportView(r, words, loaded.timeZone, first, loaded.formats), by: loaded.people.get(r.ranAs)?.name ?? "", workspace: ws!.name, subdomain: ws!.subdomain };
}

// 11i: the table's rows with plain numbers.
export const reportCsv = (v: ReportView) => toCsv([v.csv.columns, ...v.csv.rows.map((row) => row.map((c) => String(c)))]);
