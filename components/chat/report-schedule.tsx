"use client";

import { Bookmark, Mail } from "lucide-react";
import { useEffect, useState } from "react";
import { reportSaved, saveReportForLater, scheduleReport, unsaveReport } from "@/app/ws/[ws]/(app)/reports/actions";
import { Picker } from "@/components/picker";
import type { ReportEvery, SavedState } from "@/server/kernel/report/saved";

// M33 (m33-a, m33-b): Save in the report panel's top line, and once saved, how often it's emailed to the admin who
// asked for it. The kernel keeps both; this only shows them and sends the choice.

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;
const HOW = [
  { id: "off", label: "Off" },
  { id: "day", label: "Every day" },
  { id: "week", label: "Every week" },
  { id: "month", label: "Every month" },
];
const select = "h-8 w-auto flex-none gap-1.5 pr-2 pl-3 font-medium";

type Result = { ok: true; state: SavedState } | { ok: false; error: string };

export function useSaved(reportId: string) {
  const [state, setState] = useState<SavedState | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void reportSaved(reportId).then((r) => live && r.ok && setState(r.state));
    return () => void (live = false);
  }, [reportId]);
  const apply = async (run: Promise<Result>) => {
    const r = await run;
    if (r.ok) (setState(r.state), setProblem(null));
    else setProblem(r.error);
  };
  return { state, problem, apply };
}

export function SaveButton({ reportId, saved }: { reportId: string; saved: ReturnType<typeof useSaved> }) {
  const on = !!saved.state?.saved;
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={!saved.state}
      onClick={() => void saved.apply(on ? unsaveReport(reportId) : saveReportForLater(reportId))}
      className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[6px] border border-line bg-white px-3.5 text-[15px] font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,.05)] outline-none hover:bg-page focus-visible:ring-3 focus-visible:ring-focus"
    >
      <Bookmark size={15} strokeWidth={2} className={on ? "fill-primary text-primary" : ""} />
      {on ? "Saved" : "Save"}
    </button>
  );
}

export function ScheduleRow({ reportId, saved }: { reportId: string; saved: ReturnType<typeof useSaved> }) {
  const s = saved.state;
  if (!s?.saved) return null;
  const every = s.every;
  const pick = (e: ReportEvery | null) => void saved.apply(scheduleReport(reportId, e));
  const how = (id: string | null) =>
    id === "off" ? pick(null) : id === "day" ? pick({ unit: "day" }) : id === "week" ? pick({ unit: "week", weekday: every?.unit === "week" ? every.weekday : 1 }) : id === "month" ? pick({ unit: "month", day: every?.unit === "month" ? every.day : 1 }) : undefined;
  return (
    <div className="flex flex-col gap-1 border-t border-line px-6 py-3">
      <div className="flex items-center gap-2.5 text-[15px]">
        <Mail size={16} strokeWidth={1.8} className="text-icon" />
        <span className="whitespace-nowrap">Email it to me</span>
        <Picker label="How often" className={select} value={every?.unit ?? "off"} options={HOW} onChange={how} />
        {every?.unit === "week" ? (
          <>
            <span>on</span>
            <Picker label="Day of the week" className={select} value={String(every.weekday)} options={WEEKDAYS.map((d, i) => ({ id: String(i + 1), label: d }))} onChange={(id) => id && pick({ unit: "week", weekday: Number(id) })} />
          </>
        ) : every?.unit === "month" ? (
          <>
            <span>on the</span>
            <Picker label="Day of the month" className={select} value={String(every.day)} options={Array.from({ length: 31 }, (_, i) => ({ id: String(i + 1), label: ordinal(i + 1) }))} onChange={(id) => id && pick({ unit: "month", day: Number(id) })} />
          </>
        ) : null}
      </div>
      {every ? <p className="m-0 text-[14.5px] text-muted">At 07:00 Bike runs it again with that day&apos;s numbers and emails you the PDF. Only you get it. Next: {s.next}.</p> : null}
      {saved.problem ? <p className="m-0 text-[14.5px] text-danger">{saved.problem}</p> : null}
    </div>
  );
}
