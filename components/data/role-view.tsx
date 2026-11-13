"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Pill } from "@/components/chips";
import { dayRange, displayValue, formatDay } from "@/lib/format";
import { useFormats } from "@/components/formats";
import { cn } from "@/lib/utils";
import { ArrowRight } from "lucide-react";
import { CHECK, Grid, Head, NO_TOOLBAR, ROW } from "@/components/table/table";
import { numeric } from "@/components/table/look";
import { columnIcon } from "./question-row";
import { ROW_RING, useRowKeys } from "./row-keys";
import { loadRows, moveRow, openRow, rowMoves, saveRow } from "@/app/ws/[ws]/(app)/c/[cap]/actions";
import type { RoleView } from "@/server/kernel/views";
import type { RowWaits } from "@/server/kernel/waiting";
import { TableCell } from "./cell";
import { StepMenu } from "./step-menu";
import { InPlace } from "./in-place";
import { UndoBar, type Undo } from "./table-edit";
import type { FieldCtx } from "./field-input";
import { shown } from "@/server/kernel/values";
import { RecordPanel, type PanelState } from "./record-panel";
import type { Names, Person, Row, SheetView, Totals } from "./types";
import { WaitingSwitch } from "./waiting-switch";

export type RoleViewProps = {
  capId: string;
  capName: string;
  view: RoleView;
  sheet: SheetView;
  first: { rows: Row[]; names: Names; totals: Totals; waits: Record<string, RowWaits> };
  people: Person[];
  me: string;
  today: string;
  hints: Record<string, string>;
  waiting: { on: boolean; all: number; count: number };
  open: PanelState | null; // the row or new form the address names (?row=, ?new=1)
  tutorial?: React.ReactNode; // the tutorial card (0.4, M24), above the table
};

const merge = (a: Names, b: Names): Names => ({ people: { ...a.people, ...b.people }, rows: { ...a.rows, ...b.rows }, files: { ...a.files, ...b.files } });

// 8a–8e, X1: a role's own table. The same rows as the Data tab would give this person, through the same
// kernel reads, with only the columns the role's view names; no sheet tabs, Filter, Sort or select.
export function RoleViewTable(p: RoleViewProps) {
  const { sheet, view } = p;
  const fmt = useFormats();
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(p.first.rows);
  const [names, setNames] = useState<Names>(p.first.names);
  const [waits, setWaits] = useState(p.first.waits);
  const [totals, setTotals] = useState<Totals>(p.first.totals);
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);
  const [panel, setPanel] = useState<PanelState | null>(p.open);
  // The header's add button links to ?new=1 on the page already open: it opens the form. Other changes to the
  // address only follow the panel (it writes them below), so they leave it as it is.
  const asksNew = p.open?.mode === "new";
  const [addressNew, setAddressNew] = useState(asksNew);
  if (addressNew !== asksNew) {
    setAddressNew(asksNew);
    if (asksNew && panel?.mode !== "new") setPanel(p.open);
  }
  const [problem, setProblem] = useState<string | null>(null);
  const loading = useRef(false);
  const people = useMemo(() => new Map(p.people.map((x) => [x.id, x])), [p.people]);
  const ctx = { names, people, steps: sheet.steps };
  const col = (id: string) => sheet.columns.find((c) => c.id === id) ?? Object.values(sheet.hints).find((c) => c.id === id);

  const reload = useCallback(async () => {
    const r = await loadRows(p.capId, sheet.id, { filters: [], offset: 0, waiting: p.waiting.on });
    if (!r.ok) return setProblem(r.error);
    setRows(r.rows);
    setNames(r.names);
    setWaits(r.waits);
    if (r.totals) setTotals(r.totals);
    router.refresh(); // the bubbles
  }, [p.capId, sheet.id, p.waiting.on, router]);

  const more = useCallback(async () => {
    if (loading.current || rows.length >= totals.count) return;
    loading.current = true;
    const r = await loadRows(p.capId, sheet.id, { filters: [], offset: rows.length, waiting: p.waiting.on });
    loading.current = false;
    if (!r.ok) return setProblem(r.error);
    setRows((old) => [...old, ...r.rows]);
    setNames((old) => merge(old, r.names));
    setWaits((old) => ({ ...old, ...r.waits }));
  }, [p.capId, sheet.id, p.waiting.on, rows.length, totals.count]);

  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = end.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && void more());
    io.observe(el);
    return () => io.disconnect();
  }, [more]);

  const show = useCallback(async (rowId: string, mode: "view" | "edit" = "view") => {
    const r = await openRow(rowId);
    if (!r.ok) return setProblem(r.error);
    setNames((old) => merge(old, r.names));
    setPanel({ mode, row: r.row, moves: r.moves, wait: r.wait, line: r.line });
  }, []);
  // A status pill in the table (0.3): its moves when opened; a move reloads the table, and the panel if it's that row.
  const movesOf = async (rowId: string) => {
    const r = await rowMoves(rowId);
    return r.ok ? r.moves : [];
  };
  const moveFromTable = async (rowId: string, to: string) => {
    const r = await moveRow(rowId, to);
    if (!r.ok) return setProblem(r.error);
    void reload();
    if (panel?.mode === "view" && panel.row.id === rowId) void show(rowId);
  };
  const titleOf = (r: Row) => {
    const c = sheet.columns.find((x) => x.id === sheet.titleColumn);
    return c ? displayValue(c, r.data[c.id], { person: (id) => names.people[id], row: (id) => names.rows[id] }, fmt) : "";
  };
  // Through Next's router, not history.replaceState: a refresh in flight (after a save) would otherwise be
  // aborted by the address changing under it, and Next falls back to reloading the whole page.
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("row");
    url.searchParams.delete("new");
    // ?new=1 only comes in from a link (the add button, ⌘K, Home) and is cleared once the form is open: writing it
    // back here raced with closing the form, and a late page for it opened the form again.
    if (panel && panel.mode !== "new") url.searchParams.set("row", panel.row.id);
    if (url.href !== window.location.href) router.replace(`${url.pathname}${url.search}`, { scroll: false });
  }, [panel, router]);

  // What happens next on a row: what it asks of this person, else who else it waits on, else the view's
  // own column ("Referred by Maya Chen").
  function next(r: Row): string {
    const w = waits[r.id];
    const mine = w?.mine[0];
    if (mine) return [mine.label ?? mine.step ?? "", mine.due === p.today ? "due today" : null].filter(Boolean).join(" · ");
    if (w?.others.length) return `with ${w.others.join(", ")}`;
    const c = view.next ? col(view.next) : undefined;
    const v = c ? r.data[c.id] : null;
    if (!c || v === null || v === undefined || v === "") return "—";
    return `${c.name} ${displayValue(c, v, { person: (id) => names.people[id], row: (id) => names.rows[id] }, fmt)}`;
  }

  // Working in the table (0.3, M18): a plain cell the person may change opens its input in place (a date range or a
  // value with a hint opens the row, as before); an Undo bar follows the change.
  const [undo, setUndo] = useState<Undo | null>(null);
  const fieldCtx: FieldCtx = { capId: p.capId, people: p.people, names, steps: sheet.steps, onFileName: (id, name) => setNames((old) => ({ ...old, files: { ...old.files, [id]: name } })) };
  function cell(r: Row, vc: RoleView["columns"][number]) {
    const c = col(vc.column);
    const content = display(r, vc);
    if (!c || vc.to || vc.hint || !sheet.canEdit || c.type === "computed" || c.type === "step" || c.replacedBy || c.id === sheet.titleColumn || !shown(c, r.data, p.today)) return content;
    const save = async (value: unknown): Promise<string | null> => {
      const before = r.data[c.id] ?? null;
      const saved = await saveRow(p.capId, sheet.id, r.id, { [c.id]: value ?? null });
      if (!saved.ok) return saved.error;
      void reload();
      if (panel?.mode === "view" && panel.row.id === r.id) void show(r.id);
      setUndo({
        text: `Changed ${c.name} on ${titleOf(r)}`,
        run: async () => {
          const back = await saveRow(p.capId, sheet.id, r.id, { [c.id]: before });
          if (!back.ok) setProblem(back.error);
          void reload();
        },
      });
      return null;
    };
    const v = r.data[c.id];
    return <InPlace compact column={c} value={v} display={content} empty={v === null || v === undefined || v === ""} canEdit ctx={fieldCtx} onSave={save} />;
  }

  function display(r: Row, vc: RoleView["columns"][number]) {
    const c = col(vc.column);
    if (!c) return null;
    const v = r.data[c.id];
    if (vc.to) return typeof v === "string" ? dayRange(v, String(r.data[vc.to] ?? ""), fmt) : <Missing />;
    if (v === null || v === undefined || v === "") return c.type === "file" ? null : <Missing />;
    const hintCol = vc.hint ? col(vc.hint) : undefined;
    const hint = hintCol ? r.data[hintCol.id] : null;
    // A past date this year without its year ("Oct 9", 8b); others with it ("Dec 3, 2026", 8c).
    const show = (col: typeof c, value: unknown) =>
      col.type === "date" && typeof value === "string" && value < p.today && value.slice(0, 4) === p.today.slice(0, 4)
        ? formatDay(value, fmt)
        : displayValue(col, value, { person: (id) => names.people[id], row: (id) => names.rows[id] }, fmt);
    const hintText = hintCol && hint !== null && hint !== undefined && hint !== "" ? show(hintCol, hint) : null;
    if (c.type === "step") {
      return <StepMenu key={String(v)} step={sheet.steps.find((s) => s.id === v)} steps={sheet.steps} suffix={hintText} loadMoves={() => movesOf(r.id)} onMove={(to) => moveFromTable(r.id, to)} rowTitle={titleOf(r)} />;
    }
    if (c.type === "date") return <span className="text-muted">{[show(c, v), hintText].filter(Boolean).join(" · ")}</span>;
    return (
      <>
        <TableCell column={c} value={v} ctx={ctx} />
        {hintText ? <span className="text-muted"> · {hintText}</span> : null}
      </>
    );
  }

  const openId = panel && panel.mode !== "new" ? panel.row.id : null;
  // Keyboard in the table (0.4, M21).
  const keys = useRowKeys({ ids: rows.map((r) => r.id), enabled: !panel, onOpen: (id) => void show(id) });
  const showSwitch = p.waiting.count > 0 || p.waiting.on;

  return (
    <>
      <div className={cn("flex flex-col pb-5", NO_TOOLBAR)}>
        {showSwitch ? (
          <div className="px-10 pt-2 pb-3">
            <WaitingSwitch all={p.waiting.all} waiting={p.waiting.count} on={p.waiting.on} href={(on) => (on ? "?waiting=1" : "?")} />
          </div>
        ) : null}
        {problem ? <div className="px-10 pb-3 text-[13.5px] text-[#DC2626]">{problem}</div> : null}
        <div className="px-10 pb-3 empty:hidden">{p.tutorial}</div>
        <Grid label={sheet.name}>
          <thead>
            <tr>
              <th className={CHECK} />
              {view.columns.map((vc) => {
                const c = col(vc.column);
                return (
                  <Head key={vc.column} icon={c ? columnIcon(c) : null} right={!!c && !vc.to && numeric(c)}>
                    {vc.name ?? c?.name}
                  </Head>
                );
              })}
              {view.next ? <Head icon={ArrowRight}>Next</Head> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-row={r.id} onClick={() => (keys.setCursor(r.id), void show(r.id))} className={cn("cursor-pointer", ROW, openId === r.id && "!bg-primary-light", keys.cursor === r.id && ROW_RING)}>
                <td className={CHECK} />
                {view.columns.map((vc) => {
                  const c = col(vc.column);
                  return (
                    <td key={vc.column} className={cn(c && !vc.to && numeric(c) && "text-right")}>
                      {cell(r, vc)}
                    </td>
                  );
                })}
                {view.next ? <td>{next(r)}</td> : null}
              </tr>
            ))}
          </tbody>
        </Grid>
        <div ref={end} />
      </div>
      {panel ? (
        <RecordPanel
          key={panel.mode === "new" ? "new" : `${panel.row.id}:${panel.mode}`}
          capId={p.capId}
          capName={p.capName}
          sheet={sheet}
          state={panel}
          names={names}
          people={p.people}
          me={p.me}
          today={p.today}
          hints={p.hints}
          form={view.form}
          onEdit={() => panel.mode === "view" && setPanel({ ...panel, mode: "edit" })}
          onDelete={() => undefined}
          onClose={() => (setPanel(null), setNotice(null))}
          onCancel={() => (panel.mode === "edit" ? setPanel({ ...panel, mode: "view" }) : setPanel(null))}
          notice={panel.mode === "view" && notice?.id === panel.row.id ? notice.text : null}
          onSaved={(id, again, text) => {
            setNotice(text && !again ? { id, text } : null);
            void reload();
            if (!again) void show(id);
          }}
          onFileName={(id, name) => setNames((old) => ({ ...old, files: { ...old.files, [id]: name } }))}
        />
      ) : null}
      {undo ? <UndoBar undo={undo} onDone={() => setUndo(null)} /> : null}
    </>
  );
}

const Missing = () => <Pill tone="yellow">Missing</Pill>;
