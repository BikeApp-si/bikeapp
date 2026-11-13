"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { CHECK, FOOT, Grid, Head, ROW, RowCheck, SearchBox, TitleTile, TOOLBAR, UNDER_TOOLBAR } from "@/components/table/table";
import { hasTile, numeric } from "@/components/table/look";
import { columnIcon } from "./question-row";
import { NEW_ROW } from "./new-button";
import { displayValue, formatMoney } from "@/lib/format";
import { useFormats } from "@/components/formats";
import { cn } from "@/lib/utils";
import { EmptyCapability } from "./empty-capability";
import { filterWords, loadBoard, loadGroups, loadRows, moveRow, openRow, removeRows, removeSheetView, rowMoves, saveColumns, saveRow, saveSheetView } from "@/app/ws/[ws]/(app)/c/[cap]/actions";
import type { Layout, SavedView, TableColumns } from "@/server/kernel/saved-views";
import type { GroupBy } from "@/server/kernel/query";
import type { GroupTotal } from "@/server/kernel/rows";
import { BoardView, type BoardColumn } from "./board-view";
import { ROW_RING, useRowKeys } from "./row-keys";
import { orderColumns, type Arrangement } from "./columns-menu";
import { ViewTabs } from "./view-tabs";
import type { Filter, Sort } from "@/server/kernel/query";
import { TableCell } from "./cell";
import { hiddenByFolds, TreeIndent } from "./tree-rows";
import { StepMenu } from "./step-menu";
import { InPlace } from "./in-place";
import { NewRow, UndoBar, type Undo } from "./table-edit";
import type { FieldCtx } from "./field-input";
import { shown } from "@/server/kernel/values";
import { keptByKernel } from "@/server/kernel/schema/file";
import { DatedTag, keptAsItIs } from "./dated-tag";
import { FilterButton, FilterChip, SortButton, filterText } from "./filter-sort";
import { OptionsMenu } from "./options-menu";
import { RecordPanel, type PanelState, type PanelWait } from "./record-panel";
import { DeleteRowsDialog, SelectionBar } from "./selection";
import type { Column, Names, Person, Row, SheetView, Totals } from "./types";
import type { ProposalView } from "@/server/kernel/proposals";
import { Suggestions } from "./suggestions";
import { WaitingSwitch } from "./waiting-switch";

export type DataTabProps = {
  capId: string;
  capName: string;
  capIcon: React.ReactNode; // 5i's empty state

  isAdmin: boolean;
  sheets: { id: string; name: string; count: number }[];
  sheet: SheetView;
  first: { rows: Row[]; names: Names; totals: Totals };
  people: Person[];
  me: string;
  today: string;
  hints: Record<string, string>;
  // The row or new form the address names (?row=, ?new=1), loaded on the server.
  open: { row: Row; moves: { id: string; name: string }[]; names: Names; wait: PanelWait | null; line: string | null } | { isNew: true } | null;
  // A new row started from another one's "+ Add renewal" (0.4, M22): its link, that row's title, and the way back.
  linked?: { values: Record<string, unknown>; names: Record<string, string>; back: string } | null;
  // The tutorial card (0.4, M24): above the table, so a long sheet still shows it first.
  tutorial?: React.ReactNode;
  // Waiting on me: whether the filter is on, and how many rows of this sheet wait on this person (6a's "N due").
  waiting: { on: boolean; all: number; count: number };
  suggestions?: ProposalView[]; // 8h, first in Waiting on me
  // Saved views and the person's columns (0.4); the view the address names opens first.
  saved: { views: SavedView[]; prefs: TableColumns | null };
  openViewId: string | null;
};

const merge = (a: Names, b: Names): Names => ({ people: { ...a.people, ...b.people }, rows: { ...a.rows, ...b.rows }, files: { ...a.files, ...b.files } });

// 6a: a capability's sheets as tables, with Filter, Sort and the add button; the record panel (7a–7c),
// select many (7d) and delete (7e). Filter and sort run in the kernel; rows load 100 at a time.
export function DataTab(p: DataTabProps) {
  const { sheet } = p;
  const fmt = useFormats();
  const [rows, setRows] = useState<Row[]>(p.first.rows);
  // Kept from the address it came in with: the address drops ?new=1 once the form is open.
  const [linked] = useState(p.linked ?? null);
  const [names, setNames] = useState<Names>(() => {
    const first = p.open && "row" in p.open ? merge(p.first.names, p.open.names) : p.first.names;
    return p.linked ? { ...first, rows: { ...first.rows, ...p.linked.names } } : first;
  });
  const [totals, setTotals] = useState<Totals>(p.first.totals);
  // Saved views, columns and search (0.4, M19).
  const [views, setViews] = useState<SavedView[]>(p.saved.views);
  const [viewId, setViewId] = useState<string | null>(p.openViewId);
  // The last address this page asked the router for (below).
  const asked = useRef<string | null>(null);
  const firstView = p.saved.views.find((v) => v.id === p.openViewId) ?? null;
  const [prefs, setPrefs] = useState<TableColumns | null>(p.saved.prefs);
  const [arrangement, setArrangement] = useState<Arrangement>(arrangementOf(firstView, p.saved.prefs));
  // Board and grouping (0.4, M20): the open view's, else the person's last choice.
  const [layout, setLayout] = useState<Layout>(firstView?.layout ?? p.saved.prefs?.layout ?? "table");
  const [groupBy, setGroupBy] = useState<GroupBy | null>(firstView ? firstView.groupBy : (p.saved.prefs?.groupBy ?? null));
  const layoutRef = useRef(layout);
  const groupRef = useRef(groupBy);
  const [board, setBoard] = useState<BoardColumn[] | null>(null);
  const [groups, setGroups] = useState<GroupTotal[]>([]);
  const [folded, setFolded] = useState<string[]>([]);
  const [foldedRows, setFoldedRows] = useState<string[]>([]); // a tree's rows folded shut (M28)
  const [search, setSearch] = useState("");
  const searchRef = useRef("");
  const searchBox = useRef<HTMLInputElement>(null);
  const [filters, setFilters] = useState<Filter[]>(firstView?.filters ?? []);
  const [sort, setSort] = useState<Sort | null>(firstView?.sort ?? sheet.sort ?? null);
  const [selected, setSelected] = useState<string[]>([]);
  const fromAddress: PanelState | null = !p.open ? null : "row" in p.open ? { mode: "view", row: p.open.row, moves: p.open.moves, wait: p.open.wait, line: p.open.line } : sheet.canAdd ? { mode: "new" } : null;
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);
  const [panel, setPanel] = useState<PanelState | null>(fromAddress);
  // The header's add button links to ?new=1 on the page already open: it opens the form. Other changes to the
  // address only follow the panel (it writes them below), so they leave it as it is.
  const asksNew = fromAddress?.mode === "new";
  const [addressNew, setAddressNew] = useState(asksNew);
  if (addressNew !== asksNew) {
    setAddressNew(asksNew);
    if (asksNew && panel?.mode !== "new") setPanel(fromAddress);
  }
  const [deleting, setDeleting] = useState<string[] | null>(null);
  // The top bar's add button (T1).
  useEffect(() => {
    const open = () => sheet.canAdd && setPanel({ mode: "new" });
    window.addEventListener(NEW_ROW, open);
    return () => window.removeEventListener(NEW_ROW, open);
  }, [sheet.canAdd]);
  const [problem, setProblem] = useState<string | null>(null);
  const loading = useRef(false);
  const router = useRouter();
  const people = useMemo(() => new Map(p.people.map((x) => [x.id, x])), [p.people]);
  const ctx = { names, people, steps: sheet.steps };

  // A fresh first part whenever the filter or the sort changes, or after a write.
  const reload = useCallback(async (f: Filter[], s: Sort | null) => {
    const search = searchRef.current || undefined;
    if (layoutRef.current === "board") {
      const b = await loadBoard(p.capId, sheet.id, { filters: f, search });
      if (!b.ok) return setProblem(b.error);
      setProblem(null);
      setBoard(b.columns);
      setNames((old) => merge(old, b.names));
    }
    const g = groupRef.current;
    const r = await loadRows(p.capId, sheet.id, { filters: f, sort: s ?? undefined, offset: 0, waiting: p.waiting.on, search, groupBy: g ?? undefined });
    if (!r.ok) return setProblem(r.error);
    setProblem(null);
    setRows(r.rows);
    setNames((old) => merge(old, r.names));
    if (r.totals) setTotals(r.totals);
    if (g) {
      const t = await loadGroups(p.capId, sheet.id, { filters: f, search, by: g });
      if (t.ok) setGroups(t.groups);
    }
    router.refresh(); // the bubbles and "N due"
  }, [p.capId, sheet.id, p.waiting.on, router]);
  // A board or groups chosen when the page opened load once it's drawn.
  useEffect(() => {
    if (layoutRef.current === "board" || groupRef.current) void reload(filters, sort);
    // Only when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const more = useCallback(async () => {
    if (loading.current || rows.length >= totals.count) return;
    loading.current = true;
    const r = await loadRows(p.capId, sheet.id, { filters, sort: sort ?? undefined, offset: rows.length, waiting: p.waiting.on, search: searchRef.current || undefined, groupBy: groupRef.current ?? undefined });
    loading.current = false;
    if (!r.ok) return setProblem(r.error);
    setRows((old) => [...old, ...r.rows]);
    setNames((old) => merge(old, r.names));
  }, [p.capId, sheet.id, filters, sort, rows.length, totals.count, p.waiting.on]);

  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = end.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && void more());
    io.observe(el);
    return () => io.disconnect();
  }, [more]);

  // The open row and the new form are in the address, so a link (Do it yourself) can open them.
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
    void reload(filters, sort);
    if (panel?.mode === "view" && panel.row.id === rowId) void show(rowId);
  };
  // Working in the table (0.3, M18): a cell changed in place is an ordinary one-value save, with an Undo bar; a new row
  // added in the table is an ordinary create.
  const [undo, setUndo] = useState<Undo | null>(null);
  const fieldCtx: FieldCtx = { capId: p.capId, people: p.people, names, steps: sheet.steps, onFileName: (id, name) => setNames((old) => ({ ...old, files: { ...old.files, [id]: name } })) };
  // A ledger's amount above zero reads "+3 days" (M29), so entries in and out read apart.
  const signed = (c: Column, v: number) => (c.id === sheet.ledger?.amount && v > 0 ? `+${displayValue(c, v, {}, fmt)}` : null);
  const editable = (c: Column, r: Row) => sheet.canEdit && !keptAsItIs(sheet, r) && !keptByKernel(sheet, c.id) && c.type !== "computed" && c.type !== "step" && !c.replacedBy && c.id !== sheet.titleColumn && shown(c, r.data, p.today);
  const afterWrite = (rowId: string) => {
    void reload(filters, sort);
    if (panel?.mode === "view" && panel.row.id === rowId) void show(rowId);
  };
  async function saveCell(r: Row, c: Column, value: unknown): Promise<string | null> {
    const before = r.data[c.id] ?? null;
    const saved = await saveRow(p.capId, sheet.id, r.id, { [c.id]: value ?? null });
    if (!saved.ok) return saved.error;
    afterWrite(r.id);
    setUndo({
      text: `Changed ${c.name} on ${titleOf(r)}`,
      run: async () => {
        const back = await saveRow(p.capId, sheet.id, r.id, { [c.id]: before });
        if (!back.ok) setProblem(back.error);
        afterWrite(r.id);
      },
    });
    return null;
  }
  async function addRow(values: Record<string, unknown>): Promise<string | null> {
    const made = await saveRow(p.capId, sheet.id, null, values);
    if (!made.ok) return made.error;
    void reload(filters, sort);
    const title = sheet.columns.find((c) => c.id === sheet.titleColumn);
    const name = title ? displayValue(title, values[title.id], { person: (id) => names.people[id], row: (id) => names.rows[id] }, fmt) : sheet.row.one;
    setUndo({
      text: `Added ${name}`,
      run: async () => {
        const gone = await removeRows([made.id]);
        if (!gone.ok) setProblem(gone.error);
        void reload(filters, sort);
      },
    });
    return null;
  }
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
    url.searchParams.delete("view");
    if (viewId) url.searchParams.set("view", viewId);
    // Against the last address asked for, not the one the browser shows: while an earlier change is still on its way,
    // the browser still shows the address before it, and a view picked back then matched it and was never asked for;
    // the late address then dropped it (GitHub's runners, Nov 3).
    const want = `${url.pathname}${url.search}`;
    if (want !== (asked.current ?? `${window.location.pathname}${window.location.search}`)) router.replace(want, { scroll: false });
    asked.current = want;
  }, [panel, viewId, router]);

  // `/` puts the cursor in the search box, unless the person is typing somewhere already.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || t?.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
      e.preventDefault();
      searchBox.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (search === searchRef.current) return;
    const t = setTimeout(() => {
      searchRef.current = search;
      void reload(filters, sort);
    }, 250);
    return () => clearTimeout(t);
  }, [search, filters, sort, reload]);

  // Opening a view: its filters, sort and columns (or the person's own columns when it has none).
  const openView = (id: string | null) => {
    const v = views.find((x) => x.id === id) ?? null;
    setViewId(v?.id ?? null);
    setFilters(v?.filters ?? []);
    setSort(v?.sort ?? sheet.sort ?? null);
    setArrangement(arrangementOf(v, prefs));
    const l = v ? v.layout : (prefs?.layout ?? "table");
    const g = v ? v.groupBy : (prefs?.groupBy ?? null);
    layoutRef.current = l;
    groupRef.current = g;
    setLayout(l);
    setGroupBy(g);
    setSelected([]);
    void reload(v?.filters ?? [], v?.sort ?? sheet.sort ?? null);
  };
  const view = views.find((v) => v.id === viewId) ?? null;
  const columnsNow = { order: arrangement.order, hidden: arrangement.hidden };
  const baseColumns = arrangementOf(view, prefs);
  const dirty = view
    ? !same(view.filters, filters) ||
      !same(view.sort ?? sheet.sort ?? null, sort) ||
      !same({ order: baseColumns.order, hidden: baseColumns.hidden }, columnsNow) ||
      view.layout !== layout ||
      !same(view.groupBy, groupBy)
    : filters.length > 0 || !same(sort, sheet.sort ?? null);
  const input = (name: string, shared: boolean) => ({ name, filters, sort, columns: columnsNow, shared, layout, groupBy });
  async function saveAsView(name: string, shared: boolean) {
    const r = await saveSheetView(p.capId, sheet.id, input(name, shared));
    if (!r.ok) return r.error;
    setViews((old) => (r.view.shared ? [r.view, ...old] : [...old, r.view]));
    setViewId(r.view.id);
    return null;
  }
  async function changeView(patch: Partial<{ name: string; shared: boolean; current: boolean }>) {
    if (!view) return null;
    const next = patch.current ? input(view.name, view.shared) : { name: view.name, filters: view.filters, sort: view.sort, columns: view.columns, shared: view.shared, layout: view.layout, groupBy: view.groupBy };
    const r = await saveSheetView(p.capId, sheet.id, { ...next, ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.shared !== undefined ? { shared: patch.shared } : {}) }, view.id);
    if (!r.ok) return r.error;
    setViews((old) => old.map((v) => (v.id === r.view.id ? r.view : v)));
    return null;
  }
  async function dropView() {
    if (!view) return;
    const r = await removeSheetView(view.id);
    if (!r.ok) return setProblem(r.error);
    setViews((old) => old.filter((v) => v.id !== view.id));
    openView(null);
  }
  // Column changes: the person's own columns are kept as they change; in a view with its own columns, they wait for
  // "Update to what's on screen". Widths and the frozen column are always the person's own.
  const keepPrefs = (next: TableColumns | null) => {
    setPrefs(next);
    void saveColumns(p.capId, sheet.id, next);
  };
  const arrange = (a: Arrangement) => {
    setArrangement(a);
    if (!view?.columns) keepPrefs({ order: a.order, hidden: a.hidden, widths: prefs?.widths ?? {}, frozen: a.frozen });
    else if (a.frozen !== (prefs?.frozen ?? false)) keepPrefs({ ...(prefs ?? { order: [], hidden: [], widths: {} }), frozen: a.frozen });
  };
  const resize = (id: string, width: number) => keepPrefs({ ...(prefs ?? { order: arrangement.order, hidden: arrangement.hidden, frozen: arrangement.frozen }), widths: { ...(prefs?.widths ?? {}), [id]: width } } as TableColumns);

  // Table or board, and grouping: kept in the open view on "Update", else as the person's own choice.
  const own = (patch: Partial<TableColumns>) => !view && keepPrefs({ ...(prefs ?? { order: arrangement.order, hidden: arrangement.hidden, widths: {}, frozen: arrangement.frozen }), ...patch });
  const changeLayout = (l: Layout) => {
    layoutRef.current = l;
    setLayout(l);
    own({ layout: l });
    void reload(filters, sort);
  };
  const changeGroup = (g: GroupBy | null) => {
    groupRef.current = g;
    setGroupBy(g);
    setFolded([]);
    if (!g) setGroups([]);
    own({ groupBy: g });
    void reload(filters, sort);
  };
  const groupKeyOf = (r: Row): string | null => {
    if (!groupBy) return null;
    const v = r.data[groupBy.column];
    if (v === null || v === undefined || v === "") return null;
    if (groupBy.by === "month") return String(v).slice(0, 7);
    if (groupBy.by === "team") return people.get(String(v))?.team ?? null;
    return String(v);
  };
  const changeFilters = (f: Filter[]) => (setFilters(f), setSelected([]), void reload(f, sort));
  const changeSort = (s: Sort) => (setSort(s), void reload(filters, s));

  const visibleCols = orderColumns(sheet.columns, arrangement.order).filter((c) => !arrangement.hidden.includes(c.id));
  const widths = prefs?.widths ?? {};
  const sheetCount = p.sheets.find((s) => s.id === sheet.id)?.count ?? totals.count;
  const titleIdx = Math.max(0, visibleCols.findIndex((c) => c.id === sheet.titleColumn));
  const all = rows.length > 0 && rows.every((r) => selected.includes(r.id));
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  // Keyboard in the table (0.4, M21); the board's cards move with their status menus.
  const underFolds = hiddenByFolds(rows, foldedRows);
  const rowIds = rows.filter((r) => (!groupBy || !folded.includes(String(groupKeyOf(r)))) && !underFolds.has(r.id)).map((r) => r.id);
  const foldRow = (id: string) => setFoldedRows((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));
  const keys = useRowKeys({ ids: rowIds, enabled: !panel && layout === "table", onOpen: (id) => void show(id), onToggle: toggle });
  const openId = panel && panel.mode !== "new" ? panel.row.id : null;
  const example = rows.map((r) => r.data[sheet.titleColumn]).find((v) => typeof v === "string") as string | undefined;

  // One table cell's content: a step's menu, an answer edited in place, the title's tile, or the value as text.
  const cellOf = (r: Row, c: Column, ci: number) =>
    c.type === "step" && r.data[c.id] ? (
        <StepMenu key={String(r.data[c.id])} step={sheet.steps.find((s) => s.id === r.data[c.id])} steps={sheet.steps} loadMoves={() => movesOf(r.id)} onMove={(to) => moveFromTable(r.id, to)} rowTitle={titleOf(r)} />
      ) : editable(c, r) ? (
        <InPlace
          compact
          column={c}
          value={r.data[c.id]}
          display={<TableCell column={c} value={r.data[c.id]} ctx={ctx} sortedBy={sort?.column === c.id} />}
          empty={r.data[c.id] === null || r.data[c.id] === undefined || r.data[c.id] === ""}
          canEdit
          ctx={fieldCtx}
          onSave={(v) => saveCell(r, c, v)}
        />
      ) : r.dated && r.dated !== "past" && c.id === sheet.titleColumn ? (
        // A dated sheet's row in force, or still to come (M30).
        <span className="flex min-w-0 items-center gap-2">
          {ci === 0 && hasTile(c) && typeof r.data[c.id] === "string" ? <TitleTile id={r.id} name={String(r.data[c.id])} /> : <TableCell column={c} value={r.data[c.id]} ctx={ctx} title />}
          <DatedTag sheet={sheet} row={r} fmt={fmt} />
        </span>
      ) : r.reversed && c.id === sheet.titleColumn ? (
        // A ledger's entry that another reverses (M29).
        <span className="flex min-w-0 items-center gap-2">
          {ci === 0 && hasTile(c) && typeof r.data[c.id] === "string" ? <TitleTile id={r.id} name={String(r.data[c.id])} /> : <TableCell column={c} value={r.data[c.id]} ctx={ctx} title />}
          <span className="inline-flex h-[18px] shrink-0 items-center rounded-[4px] bg-fill px-1.5 text-[12px] font-medium text-muted">Reversed</span>
        </span>
      ) : c.id === sheet.ledger?.amount && typeof r.data[c.id] === "number" && (r.data[c.id] as number) > 0 ? (
        <span className="text-ink">{signed(c, r.data[c.id] as number)}</span>
      ) : ci === 0 && c.id === sheet.titleColumn && hasTile(c) && typeof r.data[c.id] === "string" && r.data[c.id] ? (
        <TitleTile id={r.id} name={String(r.data[c.id])} />
      ) : (
        <TableCell column={c} value={r.data[c.id]} ctx={ctx} sortedBy={sort?.column === c.id} title={c.id === sheet.titleColumn} />
      );

  // 5i: nothing in any sheet yet, and no filter hiding rows.
  const empty = p.sheets.every((s) => s.count === 0) && !filters.length && !p.waiting.on;

  return (
    <>
      {empty ? (
        <EmptyCapability capId={p.capId} capName={p.capName} icon={p.capIcon} sheet={sheet} onAdd={sheet.canAdd ? () => setPanel({ mode: "new" }) : null} />
      ) : (
        <>
      {/* One line (T1): the view picker and the other sheets on the left; Search, Filter, Sort and Options on the right.
          It stays at the top while the table scrolls, and in place when a wide table scrolls sideways. */}
      <div className={TOOLBAR}>
        <ViewTabs
          allLabel={`All ${sheet.row.many}`}
          count={totals.count}
          views={views}
          active={viewId}
          dirty={dirty}
          canShare={sheet.canShare}
          onOpen={openView}
          onSave={saveAsView}
          onUpdate={async () => void (await changeView({ current: true }))}
          onRename={(name) => changeView({ name })}
          onShare={async (shared) => void (await changeView({ shared }))}
          onDelete={dropView}
        />
        {p.sheets.length > 1 || p.isAdmin ? <span aria-hidden className="mx-2 h-4 w-px shrink-0 bg-line" /> : null}
        <div className="flex min-w-0 shrink items-center gap-0.5 overflow-x-auto">
          {p.sheets
            .filter((s) => s.id !== sheet.id)
            .map((s) => (
              <Link key={s.id} href={`?sheet=${s.id}`} className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-2 text-[14.5px] text-muted hover:bg-active-nav hover:text-ink">
                {s.name}
                <span>{s.count}</span>
              </Link>
            ))}
        </div>
        {p.isAdmin ? (
          <Link href="?tab=customize" aria-label="Add a sheet" className="inline-flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted outline-none hover:bg-active-nav hover:text-ink focus-visible:ring-3 focus-visible:ring-focus">
            <Plus size={14} strokeWidth={1.8} />
          </Link>
        ) : null}
        <span className="min-w-4 flex-1" />
        <SearchBox
          label="Search this sheet"
          slash
          inputRef={searchBox}
          value={search}
          onChange={setSearch}
          onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), setSearch(""), e.currentTarget.blur())}
        />
        <FilterButton
          sheet={sheet}
          people={p.people}
          onAdd={(fs) => changeFilters([...filters, ...fs])}
          onWords={(text) => filterWords(p.capId, sheet.id, text)}
        />
        <SortButton sheet={sheet} sort={sort} onChange={changeSort} />
        <OptionsMenu
          columns={sheet.columns}
          layouts={sheet.steps.length > 0}
          layout={layout}
          onLayout={changeLayout}
          groupBy={groupBy}
          onGroup={changeGroup}
          arrangement={arrangement}
          onArrange={arrange}
          onReset={() => (setArrangement(arrangementOf(view, null)), view?.columns ? undefined : keepPrefs(null))}
        />
      </div>
      {/* Under the toolbar, only when there is something to show: the filter chips, Waiting on me, a problem, the
          suggestions and the tutorial card. They stay in place when a wide table scrolls sideways. */}
      {filters.length ? (
        <div className="sticky left-0 flex flex-wrap items-center gap-1.5 px-10 pt-3">
          {filters.map((f, i) => (
            <FilterChip key={i} text={filterText(f, sheet, p.people, fmt)} onRemove={() => changeFilters(filters.filter((_, j) => j !== i))} />
          ))}
        </div>
      ) : null}
      {p.waiting.count > 0 || p.waiting.on ? (
        <div className="sticky left-0 px-10 pt-3">
          <WaitingSwitch all={p.waiting.all} waiting={p.waiting.count} on={p.waiting.on} href={(on) => `?sheet=${sheet.id}${on ? "&waiting=1" : ""}`} />
        </div>
      ) : null}
      {problem ? <div className="sticky left-0 px-10 pt-3 text-[13.5px] text-[#DC2626]">{problem}</div> : null}
      {p.suggestions?.length ? (
        <div className="sticky left-0 pt-3 pb-4">
          <Suggestions capId={p.capId} rows={sheet.row} list={p.suggestions} people={p.people} />
        </div>
      ) : null}
      <div className="sticky left-0 px-10 pt-3 empty:hidden">{p.tutorial}</div>
      {layout === "board" && board ? (
        <BoardView
          sheet={sheet}
          columns={board}
          cardColumns={visibleCols.filter((c) => c.id !== sheet.titleColumn && c.type !== "step").slice(0, 3)}
          ctx={ctx}
          openId={openId}
          onOpen={(id) => void show(id)}
          loadMoves={movesOf}
          onMove={async (rowId, to) => {
            const r = await moveRow(rowId, to);
            if (!r.ok) return r.error;
            void reload(filters, sort);
            if (panel?.mode === "view" && panel.row.id === rowId) void show(rowId);
            return null;
          }}
          titleOf={titleOf}
        />
      ) : null}
      {/* With every waiting row still in 8h's table above, there is no table below. */}
      <div
        className={cn((filters.length || p.waiting.count > 0 || p.waiting.on || problem || p.suggestions?.length) && "mt-3", ((p.suggestions?.length && !rows.length) || layout === "board") && "hidden")}
        style={UNDER_TOOLBAR}
      >
        <Grid label={sheet.name}>
          <thead>
            <tr>
              <th className={cn(CHECK, arrangement.frozen && "left-0 z-[3]")}>
                <RowCheck always label="Select all" checked={all} mixed={!all && selected.length > 0} onChange={() => setSelected(all || selected.length ? [] : rows.map((r) => r.id))} />
              </th>
              {visibleCols.map((c) => (
                <Head
                  key={c.id}
                  icon={columnIcon(c)}
                  sorted={sort?.column === c.id ? sort.dir : null}
                  right={numeric(c)}
                  className={cn("group relative", arrangement.frozen && c.id === visibleCols[0]?.id && "left-10 z-[3]")}
                  style={widths[c.id] ? { width: widths[c.id], minWidth: widths[c.id] } : undefined}
                >
                  {c.name}
                  <ResizeHandle name={c.name} onDone={(w) => resize(c.id, w)} />
                </Head>
              ))}
              {p.isAdmin ? (
                <th className="w-full !px-1.5">
                  <Link
                    href={`?tab=customize&ask=${encodeURIComponent(`Add a column to ${sheet.name}: `)}`}
                    aria-label="Add a column"
                    className="inline-flex size-7 items-center justify-center rounded-[6px] text-[#90A1B9] hover:bg-active-nav hover:text-ink"
                  >
                    <Plus size={14} strokeWidth={1.8} />
                  </Link>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <Fragment key={r.id}>
              {groupBy && (i === 0 || groupKeyOf(rows[i - 1]!) !== groupKeyOf(r)) ? (
                <GroupHeader group={groups.find((g) => g.key === groupKeyOf(r)) ?? null} span={visibleCols.length + 1 + (p.isAdmin ? 1 : 0)} visibleCols={visibleCols} extra={p.isAdmin} folded={folded.includes(String(groupKeyOf(r)))} onToggle={() => {
                  const k = String(groupKeyOf(r));
                  setFolded((f) => (f.includes(k) ? f.filter((x) => x !== k) : [...f, k]));
                }} />
              ) : null}
              {(groupBy && folded.includes(String(groupKeyOf(r)))) || underFolds.has(r.id) ? null : (
              <tr data-row={r.id} onClick={() => (keys.setCursor(r.id), void show(r.id))} className={cn("cursor-pointer", ROW, (selected.includes(r.id) || openId === r.id) && "!bg-primary-light", keys.cursor === r.id && ROW_RING)}>
                <td className={cn(CHECK, arrangement.frozen && "sticky left-0 z-[1] bg-inherit")}>
                  <RowCheck label="Select" always={selected.length > 0} checked={selected.includes(r.id)} onChange={() => toggle(r.id)} />
                </td>
                {visibleCols.map((c, ci) => (
                  <td
                    key={c.id}
                    className={cn(
                      numeric(c) && "text-right",
                      c.replacedBy && "text-muted", // kept from before, read only (M27)
                      r.dated === "past" && "text-muted [&_*]:!text-muted", // a dated sheet's row that's over (M30)
                      editable(c, r) && "hover:shadow-[inset_0_0_0_1.5px_#1E90FF]",
                      arrangement.frozen && c.id === visibleCols[0]?.id && "sticky left-10 z-[1] bg-inherit",
                    )}
                    style={widths[c.id] ? { width: widths[c.id], minWidth: widths[c.id], maxWidth: widths[c.id], overflow: "hidden", textOverflow: "ellipsis" } : undefined}
                  >
                    {r.level !== undefined && c.id === sheet.titleColumn ? (
                      <TreeIndent row={r} folded={foldedRows.includes(r.id)} onToggle={() => foldRow(r.id)}>
                        {cellOf(r, c, ci)}
                      </TreeIndent>
                    ) : (
                      cellOf(r, c, ci)
                    )}
                  </td>
                ))}
                {p.isAdmin ? <td /> : null}
              </tr>
              )}
              </Fragment>
            ))}
            {sheet.quickRow ? <NewRow sheet={sheet} columns={visibleCols} extra={p.isAdmin ? 1 : 0} ctx={fieldCtx} onCreate={addRow} /> : null}
            <tr className={FOOT}>
              <td className={CHECK} />
              {visibleCols.map((c, i) => (
                <td key={c.id} className={cn(numeric(c) && "text-right")}>
                  {i === titleIdx
                    ? `Count ${sheetCount}${filters.length || p.waiting.on || search ? ` · showing ${totals.count}` : ""}`
                    : c.id in totals.sums
                      ? `Sum ${signed(c, totals.sums[c.id]!) ?? displayValue(c, totals.sums[c.id]!, {}, fmt)}`
                      : c.type === "step" && p.waiting.count
                        ? `${p.waiting.count} due`
                        : null}
                </td>
              ))}
              {p.isAdmin ? <td /> : null}
            </tr>
          </tbody>
        </Grid>
        <div ref={end} />
      </div>

        </>
      )}
      {undo && !selected.length ? <UndoBar undo={undo} onDone={() => setUndo(null)} /> : null}
      {selected.length ? (
        <SelectionBar
          sheet={sheet}
          ids={selected}
          people={p.people}
          onClear={() => setSelected([])}
          onDelete={() => setDeleting(selected)}
          onDone={(error) => (error ? setProblem(error) : (setSelected([]), void reload(filters, sort)))}
        />
      ) : null}
      {deleting ? (
        <DeleteRowsDialog
          sheet={sheet}
          ids={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => (setDeleting(null), setSelected([]), setPanel(null), void reload(filters, sort))}
        />
      ) : null}
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
          example={example}
          prefill={panel.mode === "new" ? linked?.values : undefined}
          onEdit={() => panel.mode === "view" && setPanel({ ...panel, mode: "edit" })}
          onDelete={() => panel.mode !== "new" && setDeleting([panel.row.id])}
          onClose={() => (setPanel(null), setNotice(null))}
          onCancel={() => (panel.mode === "edit" ? setPanel({ ...panel, mode: "view" }) : setPanel(null))}
          notice={panel.mode === "view" && notice?.id === panel.row.id ? notice.text : null}
          onSaved={(id, again, text) => {
            // Added from another row: back to it, where the new one is listed.
            if (panel.mode === "new" && linked && !again) return router.push(linked.back);
            setNotice(text && !again ? { id, text } : null);
            void reload(filters, sort);
            if (!again) void show(id);
          }}
          onFileName={(id, name) => setNames((old) => ({ ...old, files: { ...old.files, [id]: name } }))}
        />
      ) : null}
    </>
  );
}

// The columns a table opens with: the view's own, else the person's, else the sheet's order with all shown.
function arrangementOf(view: SavedView | null, prefs: TableColumns | null): Arrangement {
  const cols = view?.columns ?? prefs;
  return { order: cols?.order ?? [], hidden: cols?.hidden ?? [], frozen: prefs?.frozen ?? false };
}

// A header's right edge, dragged to change the column's width (kept for the person).
function ResizeHandle({ name, onDone }: { name: string; onDone: (width: number) => void }) {
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label="Drag to resize the column"
      title={`Resize ${name}`}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        e.preventDefault();
        const th = e.currentTarget.parentElement!;
        const start = e.clientX;
        const from = th.getBoundingClientRect().width;
        const move = (ev: PointerEvent) => {
          const w = Math.round(Math.min(800, Math.max(60, from + ev.clientX - start)));
          th.style.width = th.style.minWidth = `${w}px`;
        };
        const up = (ev: PointerEvent) => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          onDone(Math.round(Math.min(800, Math.max(60, from + ev.clientX - start))));
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize opacity-0 group-hover:bg-primary-border group-hover:opacity-100"
    />
  );
}

// Whether two filters, sorts or column lists say the same, whatever order their keys come back in from the database.
function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(norm) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, norm(x)])) : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

// A group's row in the table (0.4, M20): its name, how many rows, and its subtotals under their money columns; it folds.
function GroupHeader({ group, span, visibleCols, extra, folded, onToggle }: { group: GroupTotal | null; span: number; visibleCols: Column[]; extra?: boolean; folded: boolean; onToggle: () => void }) {
  const fmt = useFormats();
  if (!group) return <tr><td colSpan={span} /></tr>;
  return (
    <tr className="bg-page" aria-label={`${group.label}, ${group.count}`}>
      <td className={CHECK}>
        <button type="button" aria-expanded={!folded} aria-label={`${folded ? "Show" : "Fold"} ${group.label}`} onClick={onToggle} className="inline-flex size-5 cursor-pointer items-center justify-center rounded-[4px] text-muted hover:bg-fill">
          <ChevronDown size={14} strokeWidth={1.8} className={cn("transition-transform", folded && "-rotate-90")} />
        </button>
      </td>
      {visibleCols.map((c, i) => (
        <td key={c.id} className={i === 0 ? "font-semibold text-ink" : "text-muted"}>
          {i === 0 ? (
            <span>
              {group.label} <span className="font-normal text-muted">· {group.count}</span>
            </span>
          ) : c.id in group.sums ? (
            <span className="font-medium text-ink">{displayValue(c, group.sums[c.id]!, {}, fmt)}</span>
          ) : null}
        </td>
      ))}
      {extra ? <td /> : null}
    </tr>
  );
}
