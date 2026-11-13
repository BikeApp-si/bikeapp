"use client";

import { MoveBlock } from "./move-block";
import { Check, Paperclip, Plus, TriangleAlert } from "lucide-react";
import { Button } from "@/components/buttons";
import type { PlanView } from "@/server/chat/view";
import { CompactCard, PlanCard, ReplacedCard } from "./plan-card";
import { Paragraphs, ReplyTable } from "./parts";

// Bike's reply with a plan. In full while it is the plan to act on (5c, 5e, 5j, 5l); only its first line once
// a reply replaced it (5e), more came after it (5g) or Create started (5h).

export type PlanMode = "full" | "replaced" | "collapsed" | "created";
export type PlanActions = {
  open: (planId: string) => void;
  openId: string | null;
  create: (plan: PlanView, opts: { withImport: boolean; withoutRestructure: boolean; label: string }) => void;
  busy: boolean;
  build?: (label: string) => void; // Build all (4b)
  answer?: (choice: number) => void; // 4c's one question
  openReport?: string | null; // the report open in the side panel (11d)
  showReport?: (id: string) => void;
};

const ATTACH_HINT =
  "You can attach a CSV file with the {rows} you already have, to import when it’s created, and any company document that explains how this should work, such as a policy or checklist.";

function Lead({ plan, more }: { plan: PlanView; more?: boolean }) {
  const [first, ...rest] = plan.lead.split(/\n{2,}/);
  return (
    <>
      <Paragraphs text={more ? `${first} …` : first!} />
      {!more && rest.length ? <Paragraphs text={rest.join("\n\n")} /> : null}
    </>
  );
}

export function PlanReply({ plan, mode, act }: { plan: PlanView; mode: PlanMode; act: PlanActions }) {
  if (mode === "replaced")
    return (
      <>
        <Lead plan={plan} />
        <ReplacedCard plan={plan} />
      </>
    );
  if (mode === "collapsed") return <Lead plan={plan} more />;
  if (mode === "created")
    return (
      <>
        <Lead plan={plan} />
        <CompactCard plan={plan} />
      </>
    );

  const card = <PlanCard plan={plan} open={act.openId === plan.id} onOpen={() => act.open(plan.id)} />;
  const changes = plan.alsoChanges.length + plan.restructures.length > 0;
  if (!changes)
    return (
      <>
        <Lead plan={plan} />
        {plan.brief ? <Paragraphs text={plan.brief} /> : null}
        {plan.leftOut ? <Paragraphs text={plan.leftOut} /> : null}
        {plan.experience ? (
          <>
            <span>
              <b className="font-semibold">What each person will see and do.</b> {plan.experience.intro}
            </span>
            <ReplyTable head={["Who", "What they see", "What they can do"]} widths={["140px"]} rows={plan.experience.rows.map((r) => [r.who, r.sees, r.can_do])} />
          </>
        ) : null}
        {card}
        <div className="flex items-start gap-2 text-[15.5px] leading-[1.55] text-muted">
          <span className="inline-flex pt-0.5">
            <Paperclip size={15} strokeWidth={1.8} />
          </span>
          <span>{ATTACH_HINT.replace("{rows}", plan.rows.many)}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button kind="primary" disabled={act.busy} onClick={() => act.create(plan, { withImport: false, withoutRestructure: false, label: `Create ${plan.name}` })}>
            <Plus size={14} strokeWidth={2} />
            Create {plan.name}
          </Button>
        </div>
      </>
    );

  // With Also changes (5j), a data move Bike makes (5l, M27), or one it can't make yet.
  const n = plan.alsoChanges.length;
  const createLabel = `Create ${plan.name} and the ${n === 1 ? "change" : `${n} changes`}`;
  return (
    <>
      <Lead plan={plan} />
      {plan.brief ? <Paragraphs text={plan.brief} /> : null}
      <span>
        <b className="font-semibold">Also changes.</b>
        {n ? ` To work, it needs ${n} ${n === 1 ? "change" : "changes"} in what you already have:` : ""}
      </span>
      <ReplyTable
        head={["App", "Change", "Why"]}
        widths={["162px", "280px"]}
        rows={[...plan.alsoChanges, ...plan.restructures].map((c) => [c.capability, c.change, c.reason])}
      />
      {plan.moves.map((m, i) => (
        <MoveBlock key={i} move={m} />
      ))}
      {plan.restructures.length ? (
        <>
          <div className="flex gap-2.5 rounded-[10px] border border-[#FDE68A] bg-[#FFFBEB] px-3.5 py-3 text-[15.5px] leading-[1.55]">
            <span className="inline-flex pt-[3px] text-[#B45309]">
              <TriangleAlert size={16} strokeWidth={1.8} />
            </span>
            <span>
              <b className="font-semibold">{plan.restructures.length === 1 ? "One change needs" : `${plan.restructures.length} changes need`} a data move.</b>{" "}
              {plan.restructures.map((r) => r.reason).join(" ")} Bike can turn typed values into links, but it can’t move this data yet.
            </span>
          </div>
          <span>You can choose:</span>
          <ReplyTable
            head={["Option", "What happens"]}
            widths={["212px"]}
            rows={[["Go ahead without it", `${plan.name} is created without ${plan.restructures.length === 1 ? "that change" : "those changes"}. ${plan.restructures.map((r) => r.capability).join(" and ")} keeps its data as it is for now.`]]}
          />
          <span className="text-muted">Rebuilding {plan.restructures.map((r) => r.capability).join(" and ")} with the data moved comes in a later version of Bike.</span>
          <div className="flex items-center gap-2">
            <Button kind="primary" disabled={act.busy} onClick={() => act.create(plan, { withImport: false, withoutRestructure: true, label: "Go ahead without it" })}>
              Go ahead without it
            </Button>
          </div>
        </>
      ) : (
        <>
          {plan.rules.length ? (
            <>
              <span>
                <b className="font-semibold">What happens by itself</b>
                {plan.rulesFrom ? `, from ${plan.rulesFrom}:` : ":"}
              </span>
              <ReplyTable head={["When", "Then"]} widths={["212px"]} rows={plan.rules.map((r) => [r.when, r.then])} />
            </>
          ) : null}
          <span>{plan.preview}</span>
          {card}
          <div className="flex items-center gap-2">
            <Button
              kind="primary"
              disabled={act.busy || plan.moves.some((m) => !m.ok)}
              onClick={() => act.create(plan, { withImport: false, withoutRestructure: false, label: createLabel })}
            >
              <Check size={14} strokeWidth={2} />
              {createLabel}
            </Button>
          </div>
        </>
      )}
    </>
  );
}
