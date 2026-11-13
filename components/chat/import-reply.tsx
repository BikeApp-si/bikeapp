"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/buttons";
import type { PlanView } from "@/server/chat/view";
import type { Part } from "@/server/kernel/chats";
import { PlanCard } from "./plan-card";
import type { PlanActions } from "./plan-reply";
import { ReplyTable } from "./parts";

// 5g: a file checked for import into the plan. Its rows come in on Create, with the capability.
export function ImportReply({ plan, act, live }: { plan: PlanView; act: PlanActions; live: boolean }) {
  const imp = plan.import;
  if (!imp) return null;
  const n = imp.rows;
  const rows = n === 1 ? plan.rows.one : plan.rows.many;
  const k = imp.checks.length;
  return (
    <>
      <div>
        I checked {imp.fileName}. When you create {plan.name}, I’ll import its {n} {n === 1 ? "row" : "rows"} like this:
      </div>
      <ReplyTable
        head={["In your file", "Goes to", "Example"]}
        widths={["190px", undefined, "120px"]}
        rows={[
          ...imp.mapping.map((m) => [m.from, m.to, m.example]),
          ...(imp.unmapped.length ? [[imp.unmapped.join(", "), <span key="u" className="text-muted">Not imported; no matching column</span>, "—"]] : []),
        ]}
      />
      {k ? (
        <>
          <div>
            <b className="font-semibold">{k === 1 ? "1 row needs" : `${k} rows need`} a check.</b> I’ll import {k === 1 ? "it" : "them"} as below unless you tell me otherwise.
          </div>
          <ReplyTable head={["Row", "Issue", "What I’ll do"]} widths={["152px", "322px"]} rows={imp.checks.map((c) => [c.row, c.issue, c.action])} />
        </>
      ) : null}
      {live ? (
        <>
          <PlanCard plan={plan} open={act.openId === plan.id} button="Open" onOpen={() => act.open(plan.id)} />
          <div className="flex items-center gap-2">
            <Button kind="primary" disabled={act.busy} onClick={() => act.create(plan, { withImport: true, withoutRestructure: false, label: `Create and import ${n} ${rows}` })}>
              <Plus size={14} strokeWidth={2} />
              Create and import {n} {rows}
            </Button>
            <Button disabled={act.busy} onClick={() => act.create(plan, { withImport: false, withoutRestructure: false, label: "Create without data" })}>
              Create without data
            </Button>
          </div>
        </>
      ) : null}
    </>
  );
}

// 5i's Import a spreadsheet: a file checked for a capability that exists. Its rows come in on "Import N rows".
export function ImportRowsReply({ part, live, busy, onImport }: { part: Extract<Part, { kind: "import_rows" }>; live: boolean; busy: boolean; onImport: (label: string) => void }) {
  const imp = part.draft;
  const n = imp.rows;
  const rows = n === 1 ? part.rows.one : part.rows.many;
  const k = imp.checks.length;
  return (
    <>
      <div>
        I checked {imp.fileName}. I’ll import its {n} {n === 1 ? "row" : "rows"} into {part.capability} like this:
      </div>
      <ReplyTable
        head={["In your file", "Goes to", "Example"]}
        widths={["190px", undefined, "120px"]}
        rows={[
          ...imp.mapping.map((m) => [m.from, m.to, m.example]),
          ...(imp.unmapped.length ? [[imp.unmapped.join(", "), <span key="u" className="text-muted">Not imported; no matching column</span>, "—"]] : []),
        ]}
      />
      {k ? (
        <>
          <div>
            <b className="font-semibold">{k === 1 ? "1 row needs" : `${k} rows need`} a check.</b> I’ll import {k === 1 ? "it" : "them"} as below unless you tell me otherwise.
          </div>
          <ReplyTable head={["Row", "Issue", "What I’ll do"]} widths={["152px", "322px"]} rows={imp.checks.map((c) => [c.row, c.issue, c.action])} />
        </>
      ) : null}
      {live && n ? (
        <div className="flex items-center gap-2">
          <Button kind="primary" disabled={busy} onClick={() => onImport(`Import ${n} ${rows}`)}>
            <Plus size={14} strokeWidth={2} />
            Import {n} {rows}
          </Button>
        </div>
      ) : null}
    </>
  );
}
