import { File, FileText } from "lucide-react";
import { Pill, PersonChip, stepTone } from "@/components/chips";
import { displayValue, formatDay, relativeDay } from "@/lib/format";
import { useFormats } from "@/components/formats";
import { LinkChip } from "./link-chip";
import type { Column, Names, Person, Step } from "./types";

type Ctx = { names: Names; people: Map<string, Person>; steps: Step[] };

const lookup = (c: Ctx) => ({
  person: (id: string) => c.names.people[id],
  row: (id: string) => c.names.rows[id],
  file: (id: string) => c.names.files[id],
  step: (id: string) => c.steps.find((s) => s.id === id)?.name,
});

// A value in the table: people as chips, steps as pills, a file as its icon, empty as a muted dash.
// Dates and days read muted, except the column the table is sorted by (6a).
export function TableCell({ column, value, ctx, sortedBy, title }: { column: Column; value: unknown; ctx: Ctx; sortedBy?: boolean; title?: boolean }) {
  if (value === null || value === undefined || value === "") return column.type === "file" ? null : <span className="text-muted">—</span>;
  if (column.type === "step") {
    const step = ctx.steps.find((s) => s.id === value);
    return <Pill tone={stepTone(step)}>{step?.name ?? ""}</Pill>;
  }
  if (column.type === "person") {
    const p = ctx.people.get(String(value));
    return p ? <PersonChip name={p.name} tint={p.tint} /> : null;
  }
  // A file as a chip with its name (an image small), opening it without opening the row (0.3, M18).
  if (column.type === "file") {
    const name = ctx.names.files[String(value)] ?? "File";
    return (
      <a
        href={`/files/${value}`}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="inline-flex h-5 max-w-[200px] items-center gap-1 rounded-[4px] bg-fill pr-1.5 pl-0.5 text-ink hover:bg-line"
      >
        {/\.(png|jpe?g)$/i.test(name) ? (
          // eslint-disable-next-line @next/next/no-img-element -- an uploaded file, served by the files route to whoever may see it
          <img src={`/files/${value}`} alt="" className="size-4 shrink-0 rounded-[3px] object-cover" />
        ) : (
          <File size={13} strokeWidth={1.8} className="ml-0.5 shrink-0 text-icon" />
        )}
        <span className="truncate">{name}</span>
      </a>
    );
  }
  if (column.type === "link") return <LinkChip id={String(value)} name={ctx.names.rows[String(value)] ?? ""} />;
  return <TextCell column={column} value={value} ctx={ctx} sortedBy={sortedBy} title={title} />;
}

function TextCell({ column, value, ctx, sortedBy, title }: { column: Column; value: unknown; ctx: Ctx; sortedBy?: boolean; title?: boolean }) {
  const text = displayValue(column, value, lookup(ctx), useFormats());
  const quiet = !sortedBy && (column.type === "date" || column.type === "days" || column.type === "datetime");
  return <span className={title ? "font-medium" : quiet ? "text-muted" : undefined}>{text}</span>;
}

// A value in the record panel (7a), with its hints: "· in 25 days" for a date still to come, and a hint
// column beside it ("· notice date Oct 15").
export function PanelValue({ column, value, hint, hintValue, ctx, today, onOpenFile }: {
  column: Column;
  value: unknown;
  hint?: Column;
  hintValue?: unknown;
  ctx: Ctx;
  today: string;
  onOpenFile?: (id: string) => void;
}) {
  const f = useFormats();
  const extra: string[] = [];
  if (column.type === "date" && typeof value === "string" && value > today) extra.push(relativeDay(value, today));
  if (hint && hintValue !== null && hintValue !== undefined)
    extra.push(`${hint.name.toLowerCase()} ${hint.result === "date" && typeof hintValue === "string" ? formatDay(hintValue, f) : displayValue(hint, hintValue, lookup(ctx), f)}`);
  const after = extra.length ? <span className="text-[13.5px] text-muted">· {extra.join(" · ")}</span> : null;

  if (value === null || value === undefined || value === "") return <span className="text-muted">—</span>;
  if (column.type === "person") {
    const p = ctx.people.get(String(value));
    return p ? <PersonChip name={p.name} tint={p.tint} large /> : null;
  }
  if (column.type === "file") {
    const name = ctx.names.files[String(value)] ?? "File";
    return (
      <a href={`/files/${value}`} target="_blank" rel="noreferrer" onClick={() => onOpenFile?.(String(value))} className="inline-flex h-[26px] items-center gap-1.5 rounded-[4px] bg-fill px-2 text-ink hover:bg-line">
        <FileText size={14} strokeWidth={1.8} className="text-icon" />
        {name}
      </a>
    );
  }
  if (column.type === "step") {
    const step = ctx.steps.find((s) => s.id === value);
    return <Pill tone={stepTone(step)}>{step?.name ?? ""}</Pill>;
  }
  if (column.type === "link") return <LinkChip id={String(value)} name={ctx.names.rows[String(value)] ?? ""} />;
  return (
    <>
      {displayValue(column, value, lookup(ctx), f)}
      {after}
    </>
  );
}
