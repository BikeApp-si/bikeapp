import { CircleCheck, Clock, File, FileArchive, FileSpreadsheet, FileText, Loader, X } from "lucide-react";
import { Fragment } from "react";

// What chat replies are made of: text with **bold** names, simple tables, and the Step / Status list
// (brief › Behaviours: text and simple tables, with buttons for the choices).

export function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/g).map((bit, i) =>
        bit.startsWith("**") && bit.endsWith("**") ? (
          <b key={i} className="font-semibold">
            {bit.slice(2, -2)}
          </b>
        ) : (
          <Fragment key={i}>{bit}</Fragment>
        ),
      )}
    </>
  );
}

// Paragraphs, each its own block.
export function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/\n{2,}/)
        .filter(Boolean)
        .map((p, i) => (
          <span key={i}>
            <Rich text={p} />
          </span>
        ))}
    </>
  );
}

const th = "border-b border-[#CAD5E2] py-2 pr-3 text-left text-[15px] font-semibold";
const td = "border-b border-line py-2 pr-3 align-top text-[15.5px]";

export function ReplyTable({ head, rows, widths = [] }: { head: string[]; rows: React.ReactNode[][]; widths?: (string | undefined)[] }) {
  return (
    <table className="my-0.5 w-full border-collapse">
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={h} className={th} style={widths[i] ? { width: widths[i] } : undefined}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              // A row of one cell (a muted "and 9 more") runs the table's width.
              <td key={j} className={td} colSpan={r.length === 1 ? head.length : undefined}>
                {typeof c === "string" ? <Rich text={c} /> : c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export type StatusRow = { label: string; state: "done" | "doing" | "next" | "failed" | "waiting"; count?: string };

function State({ state }: { state: StatusRow["state"] }) {
  if (state === "done")
    return (
      <span className="inline-flex items-center gap-[5px] text-[#166534]">
        <CircleCheck size={14} strokeWidth={2} />
        Done
      </span>
    );
  if (state === "doing")
    return (
      <span className="inline-flex items-center gap-[5px] text-primary-text">
        <Loader size={14} strokeWidth={2} className="animate-spin" />
        Doing
      </span>
    );
  if (state === "waiting")
    return (
      <span className="inline-flex items-center gap-[5px] text-[#B45309]">
        <Clock size={14} strokeWidth={2} />
        Waiting
      </span>
    );
  if (state === "failed")
    return (
      <span className="inline-flex items-center gap-[5px] text-danger">
        <X size={14} strokeWidth={2} />
        Stopped
      </span>
    );
  return <span className="text-[#90A1B9]">Next</span>;
}

// 5b's Step / Status and 5h's Part / Status (Customize's Status column is narrower, 6d).
export function StatusTable({ head, rows, statusWidth = "140px" }: { head: "Step" | "Part" | "Capability"; rows: StatusRow[]; statusWidth?: string }) {
  // 4c: each capability with how many of its rows came in; the ones not started yet in grey.
  if (head === "Capability")
    return (
      <ReplyTable
        head={["App", "Status", "Rows"]}
        widths={[undefined, "132px", "122px"]}
        rows={rows.map((r) => [r.label, <State key={r.label} state={r.state} />, <span key="n" className={r.state === "next" ? "text-muted" : undefined}>{r.count ?? "—"}</span>])}
      />
    );
  return <ReplyTable head={[head, "Status"]} widths={[undefined, statusWidth]} rows={rows.map((r) => [r.label, <State key={r.label} state={r.state} />])} />;
}

// A file in a message, inside its bubble (5g, 5j): its name, and what it is ("CSV · 12 rows · 9 columns").
export function FileChip({ name, detail }: { name: string; detail: string }) {
  const Icon = /\.(pdf|docx|md)$/i.test(name) ? FileText : /\.(csv|xlsx)$/i.test(name) ? FileSpreadsheet : /\.zip$/i.test(name) ? FileArchive : File;
  return (
    <span className="inline-flex items-center gap-2.5 rounded-[8px] border border-line bg-white py-1.5 pr-2.5 pl-2">
      <span className="inline-flex size-7 items-center justify-center rounded-[6px] bg-fill text-icon">
        <Icon size={15} strokeWidth={1.8} />
      </span>
      <span className="flex flex-col leading-[1.35]">
        <span className="text-[15px] font-medium">{name}</span>
        <span className="text-[13.5px] text-muted">{detail}</span>
      </span>
    </span>
  );
}

// The date line above the first message of a day (12c, 12e): "Oct 22, 14:51", "Today, 09:15".
export function DateLine({ text }: { text: string }) {
  return <div className="text-center text-[13.5px] text-[#90A1B9]">{text}</div>;
}
