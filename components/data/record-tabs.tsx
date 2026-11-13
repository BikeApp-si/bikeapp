"use client";

import { useState } from "react";
import { displayValue } from "@/lib/format";
import { useFormats } from "@/components/formats";
import { cn } from "@/lib/utils";
import { shown } from "@/server/kernel/values";
import { PanelValue } from "./cell";
import type { FieldCtx } from "./field-input";
import { recordLayout } from "./form-layout";
import { COLUMN_ICONS, columnIcon, FormSection, QuestionRow } from "./question-row";
import { InPlace } from "./in-place";
import { keptByKernel } from "@/server/kernel/schema/file";
import { keptAsItIs } from "./dated-tag";
import type { Column, Names, Person, Row, SheetView, Step } from "./types";

// A record's questions in its tabs (0.3): "Basics · Dates · Documents", each with sections that fold, each question
// as a row (L2), filled in or changed in place. A short form's tabs are sections under one Details tab. A question whose condition doesn't hold isn't shown.
// With several tabs, what the sheet works out sits after the last question it reads.

type Props = {
  sheet: SheetView;
  row: Row;
  ctx: { names: Names; people: Map<string, Person>; steps: Step[] };
  fieldCtx: FieldCtx;
  today: string;
  onSave: (columnId: string, value: unknown) => Promise<string | null>;
  // Tabs after the form's own (0.4, M22): the rows that point here ("Renewals 1") and History.
  extra?: { key: string; label: React.ReactNode; name: string; content: React.ReactNode }[];
};

export function RecordTabs({ sheet, row, ctx, fieldCtx, today, onSave, extra = [] }: Props) {
  // By key, not place: the related tabs arrive after the panel opens, and a tab picked before then stays picked.
  const [picked, setPicked] = useState<string | null>(null);
  const fmt = useFormats();
  const col = (id: string) => sheet.columns.find((c) => c.id === id);
  const tabs = recordLayout(sheet);
  // With tabs of its own after the form's, a one-tab form is called Details, so the strip reads the same everywhere.
  const strip = [...tabs.map((t) => ({ key: `form:${t.name}`, name: tabs.length === 1 ? "Details" : t.name, label: tabs.length === 1 ? "Details" : t.name })), ...extra];
  const current = Math.max(0, strip.findIndex((t) => t.key === picked));
  const tab = tabs[Math.min(current, tabs.length - 1)]!;
  const extraTab = current >= tabs.length ? extra[current - tabs.length] : undefined;

  const question = (c: Column) => {
    const v = row.data[c.id];
    const hint = sheet.hints[c.id];
    const empty = v === null || v === undefined || v === "";
    const display = <PanelValue column={c} value={v} hint={hint} hintValue={hint ? row.data[hint.id] : undefined} ctx={ctx} today={today} />;
    return (
      <QuestionRow key={c.id} icon={columnIcon(c)} label={c.name}>
        <InPlace
          column={c}
          value={v}
          display={display}
          empty={empty}
          canEdit={sheet.canEdit && !keptAsItIs(sheet, row) && !keptByKernel(sheet, c.id)}
          ctx={fieldCtx}
          copy={empty ? undefined : displayValue(c, v, { person: (id) => ctx.names.people[id], row: (id) => ctx.names.rows[id], file: (id) => ctx.names.files[id] }, fmt)}
          onSave={(value) => onSave(c.id, value)}
        />
      </QuestionRow>
    );
  };

  return (
    <div className="flex flex-col">
      {strip.length > 1 ? (
        <div
          role="tablist"
          aria-label="Sections of this record"
          className="-mx-6 flex gap-5 overflow-x-auto border-b border-line px-6"
          onKeyDown={(e) => {
            const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
            if (!step) return;
            const next = (current + step + strip.length) % strip.length;
            setPicked(strip[next]!.key);
            (e.currentTarget.children[next] as HTMLElement | undefined)?.focus();
          }}
        >
          {strip.map((t, i) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={i === current}
              tabIndex={i === current ? 0 : -1}
              onClick={() => setPicked(t.key)}
              className={cn("-mb-px inline-flex h-10 shrink-0 cursor-pointer items-center gap-1.5 border-b-2 text-[15px] outline-none focus-visible:text-primary-text", i === current ? "border-primary font-medium text-ink" : "border-transparent text-muted hover:text-ink")}
            >
              {t.label}
            </button>
          ))}
        </div>
      ) : null}
      {extraTab ? (
        <div role="tabpanel" aria-label={extraTab.name} className="flex flex-col">
          {extraTab.content}
        </div>
      ) : (
      <div role={strip.length > 1 ? "tabpanel" : undefined} aria-label={strip.length > 1 ? strip[current]!.name : undefined} className="flex flex-col">
        {tab.sections.map((s, i) => {
          const columns = s.columns.map(col).filter((c): c is Column => !!c && shown(c, row.data, today));
          if (!columns.length) return null;
          return (
            <FormSection key={`${tab.name}:${s.name ?? i}`} name={s.name}>
              {columns.map(question)}
            </FormSection>
          );
        })}
      </div>
      )}
    </div>
  );
}
