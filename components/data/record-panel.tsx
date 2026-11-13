"use client";

import { TOP_BAR_BG } from "@/lib/chrome";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, CircleCheck, Lock, Pencil, Send, Trash2, Undo2, X } from "lucide-react";
import { Button, IconButton } from "@/components/buttons";
import { PersonChip, Pill, stepTone } from "@/components/chips";
import { displayValue, type Formats } from "@/lib/format";
import { useFormats } from "@/components/formats";
import { cn } from "@/lib/utils";
import { decideRow, moveRow, previewNew, reverseRow, rowRelated, saveRow } from "@/app/ws/[ws]/(app)/c/[cap]/actions";
import { DropDocument } from "./drop-document";
import { COLUMN_ICONS, columnIcon, FormSection, QuestionRow } from "./question-row";
import { PanelValue } from "./cell";
import { StepMenu } from "./step-menu";
import { RecordTabs } from "./record-tabs";
import { RelatedTab } from "./related-tab";
import { HistoryTab } from "./history-tab";
import type { RelatedSheet } from "@/server/kernel/related";
import { shown } from "@/server/kernel/values";
import { keptByKernel } from "@/server/kernel/schema/file";
import { keptInForce } from "@/server/kernel/dated-words";
import { DatedTag, keptAsItIs } from "./dated-tag";
import { FieldInput, type FieldCtx } from "./field-input";
import type { Column, Names, Person, Row, SheetView } from "./types";

// wait: why the row waits on this person (X1), and the decision they are asked for, if any. line: 7a's date line.
export type PanelWait = { reason: string; decisionWaitId: string | null };
export type PanelState =
  | { mode: "view" | "edit"; row: Row; moves: { id: string; name: string }[]; wait?: PanelWait | null; line?: string | null }
  | { mode: "new" };

type Props = {
  capId: string;
  capName: string;
  sheet: SheetView;
  state: PanelState;
  names: Names;
  people: Person[];
  me: string;
  today: string;
  hints: Record<string, string>; // column id → the hint under its field in a new row ("Leave empty for one year after Start.")
  example?: string; // a title already in the sheet, for the title field's placeholder ("e.g. Northwind")
  // A role view's form (8f, 8g): its rows of fields.
  form?: (string | [string, string])[];
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
  onCancel: () => void; // edit: back to the record; new: close
  // notice: the line shown at the top of the new row's panel after Create ("Sent to Priya Nair. …").
  onSaved: (id: string, again: boolean, notice?: string) => void;
  notice?: string | null;
  onFileName: (id: string, name: string) => void;
  // A new row's values already given (0.4, M22: the link from "+ Add renewal"), asked even when the quick form doesn't.
  prefill?: Record<string, unknown>;
};

// What a question's first focus goes to: its input, or its picked (or first) choice pill.
const FOCUSABLE = "input:not([type=file]), textarea, button:not([tabindex='-1'])";

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// The columns a form shows: everything but computed columns and columns kept from before (M27, read only), in
// sheet order. A new row's step is shown fixed.
// Nor the columns the kernel fills: a ledger's balance and reversal (M29).
const formColumns = (sheet: SheetView) => sheet.columns.filter((c) => c.type !== "computed" && !c.replacedBy && !keptByKernel(sheet, c.id));

function defaultsFor(sheet: SheetView, me: string, today: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of sheet.columns) {
    const d = c.default;
    if (c.type === "step") out[c.id] = sheet.steps.find((s) => s.start)?.id ?? null;
    else if (d?.kind === "value") out[c.id] = d.value;
    else if (d?.kind === "creator") out[c.id] = me;
    else if (d?.kind === "today") out[c.id] = today;
  }
  return out;
}

// 560 px from the right, the full window height, over the content with nothing dimmed; Esc, × or a click outside
// closes it (developer notes §5).
export function RecordPanel(p: Props) {
  const { sheet, state } = p;
  const fmt = useFormats();
  const people = useMemo(() => new Map(p.people.map((x) => [x.id, x])), [p.people]);
  const editing = state.mode !== "view";
  const start = state.mode === "new" ? { ...defaultsFor(sheet, p.me, p.today), ...p.prefill } : state.row.data;
  // The panel is keyed by row and mode, so another row (or view → edit) starts from its own values.
  const [values, setValues] = useState<Record<string, unknown>>(start);
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [again, setAgain] = useState(false);
  const [filled, setFilled] = useState(0);
  const [all, setAll] = useState(false);
  // The rows that point at this one (0.4, M22), for their tabs.
  const [related, setRelated] = useState<RelatedSheet[] | null>(null);
  const viewing = state.mode === "view" ? state.row.id : null;
  useEffect(() => {
    if (viewing) void rowRelated(viewing).then((r) => r.ok && setRelated(r.sheets));
  }, [viewing]);

  // A form is filled from the keyboard: the first question is focused, Enter goes to the next one (in long text
  // it's a new line), ⌘/Ctrl+Enter saves.
  const form = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (editing) form.current?.querySelector("[data-question]")?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [editing]);
  function onFormKey(e: React.KeyboardEvent) {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      return void save();
    }
    const at = e.target as HTMLElement;
    if (at.tagName !== "INPUT" || (at as HTMLInputElement).type === "checkbox") return;
    e.preventDefault();
    const all = [...(form.current?.querySelectorAll<HTMLElement>("[data-question]") ?? [])];
    const i = all.findIndex((q) => q.contains(at));
    all[i + 1]?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }

  useEffect(() => {
    // Esc closes the panel, unless a question being changed in place took it.
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && p.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p]);

  const ctx = { names: p.names, people, steps: sheet.steps };
  const fieldCtx: FieldCtx = { capId: p.capId, people: p.people, names: p.names, steps: sheet.steps, onFileName: p.onFileName };
  const stepCol = sheet.columns.find((c) => c.type === "step");
  const stepId = (state.mode === "new" ? values : state.row.data)[stepCol?.id ?? ""] as string | undefined;
  const step = sheet.steps.find((s) => s.id === stepId);
  const titleCol = sheet.columns.find((c) => c.id === sheet.titleColumn)!;
  const title = state.mode === "new" ? null : displayValue(titleCol, state.row.data[titleCol.id], { person: (id) => p.names.people[id], row: (id) => p.names.rows[id] }, fmt);
  const changed = state.mode === "edit" ? formColumns(sheet).filter((c) => !same(values[c.id], state.row.data[c.id])) : [];
  const viewForm = state.mode === "new" && p.form ? p.form : null;
  const fileColumn = sheet.columns.find((c) => c.type === "file");
  const wait = state.mode === "view" ? state.wait : null;

  // A view's form says, as it is filled in, who the new row goes to and how the sheet's checks come out.
  const [preview, setPreview] = useState<{ goesTo: { id: string; name: string; why: string | null }[]; checks: { name: string; ok: boolean; reason: string | null }[] } | null>(null);
  useEffect(() => {
    if (!viewForm) return;
    const t = setTimeout(async () => {
      const send = Object.fromEntries(Object.entries(values).filter(([id]) => id !== stepCol?.id));
      const r = await previewNew(p.capId, sheet.id, send);
      if (r.ok && !r.problems.length) setPreview({ goesTo: r.goesTo, checks: r.checks });
    }, 300);
    return () => clearTimeout(t);
  }, [values, viewForm, p.capId, sheet.id, stepCol?.id]);

  // A changed answer clears its message ("Type is needed."): pills, people and dates have no other way to, and a
  // message left behind kept Create from saving a form that was now complete. A value that doesn't parse never reaches
  // here (its input reports it with onError instead).
  function change(columnId: string, value: unknown) {
    setValues((old) => ({ ...old, [columnId]: value }));
    setErrors((old) => (old[columnId] ? { ...old, [columnId]: null } : old));
  }

  async function save() {
    const missing = formColumns(sheet).filter((c) => c.required && (values[c.id] === null || values[c.id] === undefined || values[c.id] === "") && shown(c, values, p.today));
    const next = { ...errors, ...Object.fromEntries(missing.map((c) => [c.id, `${c.name} is needed.`])) };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    setBusy(true);
    const send = state.mode === "edit" ? Object.fromEntries(changed.map((c) => [c.id, values[c.id] ?? null])) : Object.fromEntries(Object.entries(values).filter(([id]) => id !== stepCol?.id));
    const r = await saveRow(p.capId, sheet.id, state.mode === "edit" ? state.row.id : null, send);
    setBusy(false);
    if (!r.ok) return setProblem(r.error);
    p.onSaved(r.id, state.mode === "new" && again, state.mode === "new" ? createdNotice() : undefined);
    if (state.mode === "new" && again) setValues({ ...defaultsFor(sheet, p.me, p.today), ...p.prefill });
  }

  // After Create: who it went to, from the same preview "It goes to …" uses, else that it was created.
  function createdNotice() {
    const to = preview?.goesTo.map((g) => g.name) ?? [];
    if (!to.length) return `${sheet.row.one.charAt(0).toUpperCase()}${sheet.row.one.slice(1)} created.`;
    return `Sent to ${to.join(" and ")}. You'll see it under your requests.`;
  }

  // One question changed in place (0.3): an ordinary save of that one value.
  async function saveOne(columnId: string, value: unknown): Promise<string | null> {
    if (state.mode === "new") return null;
    const r = await saveRow(p.capId, sheet.id, state.row.id, { [columnId]: value ?? null });
    if (!r.ok) return r.error;
    p.onSaved(r.id, false);
    return null;
  }

  // The form's questions (0.3). New: the ones asked when a row is added, unless all are asked for; edit, or all:
  // every one, under its tab's name. Questions whose condition doesn't hold aren't asked.
  const groups: { name: string | null; columns: Column[] }[] = (() => {
    const col = (id: string) => sheet.columns.find((c) => c.id === id);
    // A column kept from before (M27) is shown on a record, read only, and never asked on a new row.
    const ask = (c: Column | undefined): c is Column => !!c && shown(c, values, p.today) && !(state.mode === "new" && (c.replacedBy || keptByKernel(sheet, c.id)));
    const step = stepCol && state.mode === "new" ? [stepCol] : stepCol && state.mode === "edit" ? [stepCol] : [];
    if (state.mode === "new" && !all) {
      const given = Object.keys(p.prefill ?? {}).filter((id) => !sheet.quick.includes(id));
      return [{ name: null, columns: [...given.map(col).filter(ask), ...sheet.quick.map(col).filter(ask), ...step] }];
    }
    const tabs = sheet.tabs.map((t) => ({ name: sheet.tabs.length > 1 ? t.name : null, columns: t.sections.flatMap((x) => x.columns).map(col).filter(ask) }));
    tabs[0]!.columns.push(...step);
    return tabs;
  })();
  const more = state.mode === "new" && !viewForm && !all && sheet.tabs.flatMap((t) => t.sections.flatMap((x) => x.columns)).length > sheet.quick.length;

  async function move(to: string) {
    if (state.mode === "new") return;
    setBusy(true);
    const r = await moveRow(state.row.id, to);
    setBusy(false);
    if (!r.ok) return setProblem(r.error);
    p.onSaved(r.id, false);
  }

  // A dated sheet's row that has started (M30): kept as it is.
  const kept = state.mode !== "new" && keptAsItIs(sheet, state.row);

  // A ledger's entry (M29): reversed once, never if it reverses another; the kernel decides, this only offers it.
  const reversible = state.mode === "view" && !!sheet.ledger && sheet.canAdd && !state.row.reversed && typeof state.row.data[sheet.ledger.reverses] !== "string";
  async function reverse() {
    if (state.mode === "new") return;
    setBusy(true);
    const r = await reverseRow(state.row.id);
    setBusy(false);
    if (!r.ok) return setProblem(r.error);
    p.onSaved(state.row.id, false);
  }

  async function decide(choice: "approve" | "decline") {
    if (!wait?.decisionWaitId) return;
    setBusy(true);
    const r = await decideRow(wait.decisionWaitId, choice);
    setBusy(false);
    if (!r.ok) return setProblem(r.error);
    p.onSaved(r.id, false);
  }

  // The primary move is the next step forward; exits are outlined; a move back is a quiet ghost button.
  const at = sheet.steps.findIndex((s) => s.id === stepId);
  const forward = state.mode === "view" ? state.moves.find((m) => sheet.steps.findIndex((s) => s.id === m.id) > at && sheet.steps.find((s) => s.id === m.id)?.end !== "exit") : undefined;
  const isBack = (id: string) => sheet.steps.find((s) => s.id === id)?.end !== "exit" && sheet.steps.findIndex((s) => s.id === id) < at;
  const rank = (id: string) => (id === forward?.id ? 0 : isBack(id) ? 2 : 1);

  return (
    <>
      <div className="absolute inset-0 z-10" onClick={p.onClose} />
      <aside role="dialog" aria-label={title ?? sheet.addAction} className="absolute inset-y-0 right-0 z-20 flex w-[560px] flex-col border-l border-line bg-white">
        {/* Its lines meet the main panel's (T1 small thing 5): the header's at 56 px, the title block's at 136 px. */}
        <div className={cn("flex h-14 shrink-0 items-center gap-1.5 border-b border-line pr-3 pl-6", TOP_BAR_BG)}>
          <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-ink">{state.mode === "new" ? sheet.addAction : sheet.name}</span>
          {state.mode === "view" ? (
            <>
              {sheet.canEdit && !kept ? (
                <Button small className="h-8" onClick={p.onEdit}>
                  <Pencil size={14} strokeWidth={1.8} />
                  Edit
                </Button>
              ) : null}
              {reversible ? (
                <Button small className="h-8" disabled={busy} onClick={reverse}>
                  <Undo2 size={14} strokeWidth={1.8} />
                  Reverse
                </Button>
              ) : null}
              {sheet.canDelete && !kept ? (
                <IconButton aria-label="Delete" className="text-[#DC2626]" onClick={p.onDelete}>
                  <Trash2 size={16} strokeWidth={1.8} />
                </IconButton>
              ) : null}
            </>
          ) : state.mode === "edit" ? (
            <span className="inline-flex h-[22px] items-center rounded-[6px] bg-primary-light px-2 text-[13.5px] font-medium text-primary-hover">Editing</span>
          ) : null}
          <IconButton aria-label="Close" onClick={p.onClose}>
            <X size={16} strokeWidth={1.8} />
          </IconButton>
        </div>
        {state.mode === "new" ? null : (
          <div className="flex h-20 shrink-0 flex-col justify-center gap-0.5 border-b border-line px-6">
            <div className="flex items-center gap-2.5">
              <span className="flex min-w-0 flex-1 items-center gap-2.5 text-[22px] font-semibold tracking-[-0.01em]">
                {title}
                {state.mode === "view" ? <DatedTag sheet={sheet} row={state.row} fmt={fmt} large /> : null}
              </span>
              {state.mode === "view" ? (
                <StepMenu step={step} steps={sheet.steps} moves={state.moves} onMove={move} rowTitle={title ?? ""} large />
              ) : step ? (
                <Pill tone={stepTone(step)} className="h-[24px] rounded-[6px] px-2 text-[13.5px] font-medium">{step.name}</Pill>
              ) : null}
            </div>
            {state.mode === "view" && state.line ? <span className="text-[15px] text-muted">{state.line}</span> : null}
          </div>
        )}

        <div ref={form} onKeyDown={editing ? onFormKey : undefined} className="flex flex-1 flex-col overflow-auto px-6">
          {state.mode === "view" && p.notice ? (
            <div role="status" className="mt-3 flex items-center gap-2 rounded-[8px] bg-[#DDF6E2] px-3 py-2.5 text-[15px] text-[#18794E]">
              <CircleCheck size={16} strokeWidth={1.8} />
              {p.notice}
            </div>
          ) : null}
          {/* 7c: a new row whose sheet holds a document can start from it. */}
          {state.mode === "new" && !viewForm && fileColumn ? (
            <DropDocument
              capId={p.capId}
              sheetId={sheet.id}
              what={fileColumn.name.toLowerCase()}
              onFilled={(values, file) => {
                p.onFileName(file.id, file.name);
                setValues((old) => ({ ...old, ...values }));
                setFilled((n) => n + 1);
                // What the document filled is checked before creating, so every question shows.
                setAll(true);
              }}
            />
          ) : null}
          {state.mode === "view"
            ? (
                <RecordTabs
                  sheet={sheet}
                  row={state.row}
                  ctx={ctx}
                  fieldCtx={fieldCtx}
                  today={p.today}
                  onSave={saveOne}
                  extra={[
                    ...(related ?? []).map((g) => ({
                      key: `related:${g.sheetId}:${g.column.id}`,
                      name: g.sheet,
                      label: (
                        <>
                          {g.sheet}
                          <span className="text-[13.5px] font-normal text-muted">{g.count}</span>
                        </>
                      ),
                      content: <RelatedTab group={g} rowId={state.row.id} people={people} />,
                    })),
                    { key: "history", name: "History", label: "History", content: <div className="py-3"><HistoryTab rowId={state.row.id} stamp={JSON.stringify(state.row.data)} people={people} /></div> },
                  ]}
                />
              )
            : viewForm
              ? (
                  <FormSection name="Your request" open={viewForm.flat().some((id) => errors[id])}>
                    {viewForm.flat().map((id) => {
                      const c = sheet.columns.find((x) => x.id === id);
                      return c && shown(c, values, p.today) ? (
                        <FormField key={id} column={c} note={<Note error={errors[c.id]} was={null} />}>
                          <FieldInput flat column={c} value={values[c.id]} ctx={fieldCtx} onChange={(v) => change(c.id, v)} onError={(e) => setErrors((old) => ({ ...old, [c.id]: e }))} />
                        </FormField>
                      ) : null;
                    })}
                  </FormSection>
                )
              : groups.map((g, i) => (
                  <FormSection key={g.name ?? i} name={g.name} open={g.columns.some((c) => errors[c.id])}>
                    {g.columns.map((c) => (
                      <FormField
                        // Drawn again when a dropped document fills the form (7c): a text field keeps what was typed.
                        key={`${c.id}:${state.mode === "edit" ? state.row.id : "new"}:${filled}`}
                        column={c}
                        note={
                          <Note
                            error={errors[c.id]}
                            was={state.mode === "edit" && !same(values[c.id], state.row.data[c.id]) ? wasText(c, state.row.data[c.id], p.names, fmt) : null}
                            hint={state.mode === "new" ? p.hints[c.id] : undefined}
                          />
                        }
                      >
                        {c.type === "step" && state.mode === "new" ? (
                          <span className="flex h-8 items-center">
                            <Pill tone={stepTone(step)}>{step?.name}</Pill>
                          </span>
                        ) : (
                          <FieldInput
                            flat
                            column={c}
                            value={values[c.id]}
                            ctx={fieldCtx}
                            placeholder={c.id === sheet.titleColumn && p.example ? `e.g. ${p.example}` : undefined}
                            onChange={(v) => change(c.id, v)}
                            onError={(e) => setErrors((old) => ({ ...old, [c.id]: e }))}
                          />
                        )}
                      </FormField>
                    ))}
                  </FormSection>
                ))}
          {more ? (
            <button type="button" onClick={() => setAll(true)} className="mb-3 self-start cursor-pointer text-[14.5px] text-primary-text hover:text-primary-hover">
              Show all questions
            </button>
          ) : null}
          {viewForm && preview && (preview.goesTo.length || preview.checks.length) ? (
            <FormSection name="What happens next">
              <GoesTo preview={preview} people={p.people} />
            </FormSection>
          ) : null}
          {wait ? <div className="my-3 rounded-[8px] bg-fill px-3 py-2.5 text-[15px] leading-[1.5] text-icon">{wait.reason}</div> : null}
        </div>

        {wait && state.mode === "view" && (wait.decisionWaitId || state.moves.length) ? (
          <div className="flex h-12 shrink-0 items-center gap-2 border-t border-line bg-white pr-3 pl-6">
            {problem ? <span className="truncate text-[13.5px] text-[#DC2626]">{problem}</span> : null}
            <span className="flex-1" />
            {wait.decisionWaitId ? (
              <>
                <Button small className="h-8" disabled={busy} onClick={() => void decide("decline")}>Decline</Button>
                <Button small className="h-8" kind="primary" disabled={busy} onClick={() => void decide("approve")}>
                  <Check size={14} strokeWidth={2} />
                  Approve
                </Button>
              </>
            ) : (
              [...state.moves]
                // Exits first, the next step last as the main button (X1: Decline, Approve).
                .sort((a, b) => rank(b.id) - rank(a.id))
                .map((m) => {
                  const s = sheet.steps.find((x) => x.id === m.id);
                  const main = m.id === forward?.id;
                  return (
                    <Button small className="h-8" key={m.id} kind={main ? "primary" : isBack(m.id) ? "ghost" : "outline"} disabled={busy} onClick={() => void move(m.id)}>
                      {main ? <Check size={14} strokeWidth={2} /> : null}
                      {isBack(m.id) ? `Back to ${m.name}` : (s?.button ?? m.name)}
                    </Button>
                  );
                })
            )}
          </div>
        ) : editing ? (
          <div className="flex h-12 shrink-0 items-center gap-2 border-t border-line bg-white pr-3 pl-6">
            {state.mode === "edit" ? (
              <span className="text-[13.5px] text-muted">{changed.length === 1 ? "1 change" : `${changed.length} changes`}</span>
            ) : viewForm ? null : (
              <label className="flex shrink-0 items-center gap-2 text-[15px] whitespace-nowrap text-ink">
                <input type="checkbox" checked={again} onChange={(e) => setAgain(e.target.checked)} className="size-4 rounded-[4px] accent-primary" />
                Create another
              </label>
            )}
            {/* The reason in full, on up to two lines ("Laptops has 2, so 3 can't be taken."), M29. */}
            {problem ? <span className="ml-2 line-clamp-2 min-w-0 flex-1 text-[13.5px] leading-[1.3] text-[#DC2626]">{problem}</span> : <span className="flex-1" />}
            <Button small className="h-8" onClick={p.onCancel}>Cancel</Button>
            <Button small className="h-8" kind="primary" disabled={busy || (state.mode === "edit" && !changed.length)} onClick={() => void save()}>
              {state.mode === "edit" ? "Save changes" : `Create ${sheet.row.one}`}
            </Button>
          </div>
        ) : problem ? (
          <div className="flex h-12 shrink-0 items-center border-t border-line px-6 text-[13.5px] text-[#DC2626]">{problem}</div>
        ) : kept && (sheet.canEdit || sheet.canDelete) ? (
          // A dated sheet's row in force (M30): why it has no Edit or Delete.
          <div className="flex min-h-12 shrink-0 items-center gap-2 border-t border-line py-2 pr-3 pl-6 text-[13.5px] text-muted">
            <Lock size={14} strokeWidth={1.8} className="shrink-0 text-icon" />
            {keptInForce(sheet)}
          </div>
        ) : null}
      </aside>
    </>
  );
}

// 8f, 8g: who the new row goes to, and the sheet's checks, worked out by the kernel as the form is filled in.
function GoesTo({ preview, people }: { preview: { goesTo: { id: string; name: string; why: string | null }[]; checks: { name: string; ok: boolean; reason: string | null }[] }; people: Person[] }) {
  const tint = (id: string) => people.find((x) => x.id === id)?.tint ?? "#62748E";
  return (
    <>
      {preview.goesTo.map((g) => (
        <QuestionRow key={g.id} icon={Send} label="It goes to">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <PersonChip name={g.name} tint={tint(g.id)} />
            {g.why ? <span className="text-muted">{g.why}</span> : null}
          </span>
        </QuestionRow>
      ))}
      {preview.checks.map((c) => (
        <QuestionRow key={c.name} icon={CircleCheck} label={c.name}>
          {c.ok ? (
            <span className="inline-flex items-center gap-1 text-[#18794E]">
              <Check size={14} strokeWidth={2} />
              OK
            </span>
          ) : (
            <span className="text-[#DC2626]">{c.reason}</span>
          )}
        </QuestionRow>
      ))}
    </>
  );
}

function wasText(c: Column, v: unknown, names: Names, fmt: Formats) {
  const text = displayValue(c, v, { person: (id) => names.people[id], row: (id) => names.rows[id], file: (id) => names.files[id] }, fmt);
  return `Was ${text || "empty"}`;
}

// One question of a form (L2): a row, "Required" said plainly at its end, and under the value the check that failed,
// what it was before, or its hint.
function FormField({ column, note, children }: { column: Column; note: React.ReactNode; children: React.ReactNode }) {
  return (
    <QuestionRow question icon={columnIcon(column)} label={column.name} note={note} right={column.required ? "Required" : undefined}>
      {children}
    </QuestionRow>
  );
}

function Note({ error, was, hint }: { error?: string | null; was: string | null; hint?: string }) {
  const text = error ?? was ?? hint;
  if (!text) return null;
  return <div className={cn("pb-1 text-[13.5px]", error ? "text-[#DC2626]" : "text-muted")}>{text}</div>;
}
