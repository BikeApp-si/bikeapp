"use client";

import { BarChart3, Download, RefreshCw, X } from "lucide-react";
import { useEffect } from "react";
import { Button, IconButton } from "@/components/buttons";
import type { ReportView } from "@/server/kernel/report/view";
import { ReportTable } from "./report-reply";
import { ReportChart } from "./report-chart";
import { SaveButton, ScheduleRow, useSaved } from "./report-schedule";

// 11d: the report in the side panel, with where its numbers come from and how they were worked out. 12c:
// reopened after its rows have changed, it says so, with Run again. M33: Save, and how often it's emailed.
export function ReportPanel({ report, changed, onRunAgain, busy, onClose }: { report: ReportView; changed: boolean; onRunAgain: () => void; busy: boolean; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  const saved = useSaved(report.id);
  const link = "inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-line bg-white px-3.5 text-[15px] font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,.05)] hover:bg-page";
  return (
    <>
      <div className="absolute inset-0" onClick={onClose} />
      <aside role="dialog" aria-label={`Report: ${report.title}`} className="absolute inset-y-0 right-0 flex w-[600px] flex-col border-l border-line bg-white">
        <div className="flex shrink-0 flex-col border-b border-line">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line pr-3 pl-6">
            <span className="flex-1 text-[15px] text-muted">Report · {report.ranAt}</span>
            <SaveButton reportId={report.id} saved={saved} />
            <a href={`/reports/${report.id}/csv`} className={link}>
              <Download size={15} strokeWidth={2} />
              CSV
            </a>
            <a href={`/reports/${report.id}/pdf`} className={link}>
              <Download size={15} strokeWidth={2} />
              PDF
            </a>
            <IconButton aria-label="Close" onClick={onClose}>
              <X size={16} strokeWidth={1.8} />
            </IconButton>
          </div>
          <div className="flex items-center gap-3 px-6 py-3.5">
            <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-[8px] border border-line bg-white text-ink">
              <BarChart3 size={17} strokeWidth={1.8} />
            </span>
            <span className="flex flex-col leading-[1.3]">
              <span className="text-[17px] font-semibold">{report.title}</span>
              <span className="text-[14.5px] text-muted">
                {report.period ? `${report.period} · ` : ""}from {report.sources}
              </span>
            </span>
          </div>
          <ScheduleRow reportId={report.id} saved={saved} />
        </div>
        <div className="flex flex-1 flex-col gap-4 overflow-auto px-5 py-4">
          {changed ? (
            <div className="flex items-center gap-3 rounded-[10px] border border-line bg-page px-3.5 py-2.5">
              <span className="flex-1 text-[15.5px]">As of {report.ranAt}. Rows have changed since.</span>
              <Button kind="primary" disabled={busy} onClick={onRunAgain}>
                <RefreshCw size={15} strokeWidth={2} />
                Run again
              </Button>
            </div>
          ) : null}
          <ReportChart chart={report.chart} compact />
          <ReportTable table={report.table} />
          <div className="flex flex-col gap-0.5 text-[15.5px] leading-[1.55]">
            <span className="font-semibold">How it was worked out</span>
            {report.how.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </div>
        </div>
      </aside>
    </>
  );
}
