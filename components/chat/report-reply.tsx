import { BarChart3, Download, Table2 } from "lucide-react";
import type { ReportView } from "@/server/kernel/report/view";
import { ReplyTable } from "./parts";
import { ReportChart } from "./report-chart";

// 11c: a report in the chat: its chart, its table, the report card that opens it in the side panel, and the
// CSV and PDF downloads.

export function Downloads({ id }: { id: string }) {
  const link = "inline-flex h-9 items-center gap-1.5 rounded-[6px] border border-line bg-white px-3.5 text-[15px] font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,.05)] hover:bg-page";
  return (
    <div className="flex gap-2">
      <a href={`/reports/${id}/csv`} className={link}>
        <Download size={15} strokeWidth={2} />
        CSV
      </a>
      <a href={`/reports/${id}/pdf`} className={link}>
        <Download size={15} strokeWidth={2} />
        PDF
      </a>
    </div>
  );
}

export function ReportTable({ table }: { table: ReportView["table"] }) {
  return <ReplyTable head={table.columns} rows={table.rows} />;
}

// brief: the card and downloads only (a scheduled send's reply, m33-c).
export function ReportReply({ report, open, opened, brief }: { report: ReportView; open: () => void; opened: boolean; brief?: boolean }) {
  const Icon = report.chart.kind === "none" && !report.firstId ? Table2 : BarChart3;
  return (
    <div className="flex flex-col gap-3">
      {brief ? null : <ReportChart chart={report.chart} />}
      {brief ? null : <ReportTable table={report.table} />}
      <div className={`flex w-[570px] max-w-full items-center gap-3.5 rounded-[10px] border px-3.5 py-3 ${opened ? "border-primary-border bg-primary-light" : "border-line bg-white"}`}>
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-[8px] border border-line bg-white text-ink">
          <Icon size={18} strokeWidth={1.8} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-[1.35]">
          <span className="text-base font-semibold">{report.title}</span>
          <span className="truncate text-[14.5px] text-muted">{report.card}</span>
        </span>
        <button type="button" onClick={open} className="inline-flex h-9 items-center rounded-[6px] border border-line bg-white px-3 text-[15px] text-ink hover:bg-page">
          Open
        </button>
      </div>
      <Downloads id={report.id} />
    </div>
  );
}
