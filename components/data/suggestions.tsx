"use client";

import { CircleDollarSign, Sparkles, Type, User } from "lucide-react";
import { CHECK, Grid, Head, ROW } from "@/components/table/table";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { changeSuggestion, confirmSureSuggestions, confirmSuggestion } from "@/app/ws/[ws]/(app)/c/[cap]/actions";
import { Button } from "@/components/buttons";
import { PersonChip } from "@/components/chips";
import { Picker } from "@/components/picker";
import type { ProposalView } from "@/server/kernel/proposals";

// 8h: the suggestions AI steps made that wait on this person, first in Waiting on me. Each one is confirmed or
// changed; nothing is saved without them. A confirmed row stays below, still waiting for whatever else it needs.

type Person = { id: string; name: string; tint: string };

// The row, its person and its amount, in the order head() names them.
const HEAD_ICONS = [Type, User, CircleDollarSign];

export function Suggestions({ capId, rows, list, people }: { capId: string; rows: { one: string; many: string }; list: ProposalView[]; people: Person[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) setError(r.error ?? null);
    router.refresh();
  };
  if (!list.length) return null;
  const column = list[0]!.column.toLowerCase();
  const sure = list.filter((p) => p.sure).length;
  const many = list.length === 1 ? rows.one : rows.many;
  const head = (p: ProposalView) => [rows.one.charAt(0).toUpperCase() + rows.one.slice(1), p.person?.column, p.amount?.column];
  const tint = (id: string) => people.find((p) => p.id === id)?.tint ?? "#62748E";

  return (
    <div className="flex flex-col gap-3">
      <div className="mx-10 flex items-center gap-3 rounded-[10px] border border-primary-border bg-primary-light px-4 py-2.5">
        <Sparkles size={16} strokeWidth={1.8} className="shrink-0 text-primary-text" />
        <div className="flex-1 text-[15.5px] leading-[1.35]">
          {list.length} {many} have no {column}. A rule sent each one to an AI step, which suggests a {column}
          {list.some((p) => p.receipt) ? " from the receipt" : ""}. Nothing is saved until you confirm.
        </div>
        {sure ? (
          <Button disabled={busy} onClick={() => void run(() => confirmSureSuggestions(capId))}>
            Confirm the {sure} sure {sure === 1 ? "one" : "ones"}
          </Button>
        ) : null}
      </div>
      {error ? <div className="px-10 text-[15px] text-danger">{error}</div> : null}
      <Grid label={`Suggested ${column}`}>
        <thead>
          <tr>
            <th className={CHECK} />
            {head(list[0]!).map((h, i) => (h ? <Head key={i} icon={HEAD_ICONS[i]}>{h}</Head> : null))}
            <Head icon={Sparkles}>Suggested {column}</Head>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.map((p) => (
            <tr key={p.id} className={ROW}>
              <td className={CHECK} />
              <td>{p.title}</td>
              {p.person ? <td>{p.person.name ? <PersonChip name={p.person.name} tint={tint(p.person.id)} /> : null}</td> : null}
              {p.amount ? <td className="text-right">{p.amount.text}</td> : null}
              <td className="py-2 !whitespace-normal">
                <span className="inline-flex h-[22px] items-center rounded-[4px] bg-primary-light px-2 text-[14.5px] font-medium text-primary-text">{p.value}</span>
                <div className="mt-0.5 text-sm leading-[1.4] text-muted">
                  {p.sure ? null : <span className="font-medium text-[#B45309]">Not sure: </span>}
                  {p.reason}
                </div>
              </td>
              <td className="pr-4">
                <div className="flex justify-end gap-1.5">
                  <Button small kind="primary" disabled={busy} onClick={() => void run(() => confirmSuggestion(p.id))}>
                    Confirm
                  </Button>
                  {p.choices.length ? (
                    <Picker
                      value={null}
                      label={`Change the ${column} of ${p.title}`}
                      options={p.choices.map((c) => ({ id: c.id, label: c.name }))}
                      onChange={(id) => id && void run(() => changeSuggestion(p.id, id))}
                      trigger={
                        <Button small disabled={busy}>
                          Change
                        </Button>
                      }
                    />
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </Grid>
    </div>
  );
}
