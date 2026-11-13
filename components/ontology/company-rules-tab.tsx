"use client";

import { ArrowUp, Check, Loader, TriangleAlert } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { applyCompanyRulesDraft, loadCompanyRules, sendToCompanyRules } from "@/app/ws/[ws]/(app)/ontology/actions";
import { Button } from "@/components/buttons";
import { DateLine, Paragraphs, ReplyTable, StatusTable } from "@/components/chat/parts";
import { cn } from "@/lib/utils";
import type { CompanyDraftView, CompanyRulesView } from "@/server/chat/company-rules-view";
import { MessageBox } from "@/components/chat/message-box";
import { NeedsModel, useModel } from "@/components/no-model";
import { NO_MODEL } from "@/lib/messages";

// The Company rules tab on the Ontology page (0.2, M14), built like Customize: the admin's chat on the left and the
// company's rules as plain text on the right. A message becomes a preview (where it applies, the last 90 days,
// warnings); nothing is live until Apply. While Bike works, the page asks for the chat again every second.

const STOPPED = "That stopped before it finished. Try again.";
type Shown = CompanyRulesView["messages"][number];

function Person({ m }: { m: Shown }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-[12px] bg-fill px-3.5 py-2.5 text-base leading-[1.55]">{m.text}</div>
    </div>
  );
}

function Warning({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-[8px] border border-[#FDE68A] bg-[#FFFBEB] px-3.5 py-2.5 text-[15px] leading-[1.55] text-[#92400E]">
      <TriangleAlert size={16} strokeWidth={2} className="mt-[3px] shrink-0" />
      <span>{text}</span>
    </div>
  );
}

// Bike's preview of a company rule, and Apply. Once applied or replaced it folds to one line.
function CompanyReply({ view, live, busy, onApply, onChange }: { view: CompanyDraftView; live: boolean; busy: boolean; onApply: () => void; onChange: () => void }) {
  const d = view.draft;
  if (view.state !== "waiting" || !live)
    return (
      <div className="text-base text-muted">
        {d.collapsed.lead} … <b className="font-medium text-ink">{d.collapsed.tail}</b>
      </div>
    );
  const n = d.preview.rows.length;
  return (
    <div className="flex flex-col gap-2.5 text-base leading-[1.6]">
      <Paragraphs text={d.reply} />
      {d.change === "remove" ? (
        <ReplyTable head={["Rule", "Stops in"]} rows={[[d.text, "Every app it applies to"]]} />
      ) : (
        <>
          {d.when && d.then ? <ReplyTable head={["When", "Then"]} rows={[[d.when, d.then]]} /> : null}
          <ReplyTable head={["Applies to", "When it applies"]} widths={[undefined, "260px"]} rows={d.appliesTo.map((a) => [a.where, a.when])} />
          <div>{n ? `On your last 90 days it would have run ${n} ${n === 1 ? "time" : "times"}:` : "On your last 90 days it wouldn't have run."}</div>
          {n ? <ReplyTable head={["Row", "Where", "When"]} widths={[undefined, undefined, "120px"]} rows={d.preview.rows.map((r) => [r.title, r.where, r.on])} /> : null}
        </>
      )}
      {d.warnings.map((w) => (
        <Warning key={w} text={w} />
      ))}
      <div className="flex gap-2">
        <Button kind="primary" disabled={busy} onClick={onApply} className="px-4">
          <Check size={14} strokeWidth={2.2} />
          {d.button}
        </Button>
        <Button disabled={busy} onClick={onChange}>
          Change something
        </Button>
      </div>
    </div>
  );
}

function Bike({ m, live, view, busy, onApply, onChange, onReply }: { m: Shown; live: boolean; view: CompanyRulesView; busy: boolean; onApply: (planId: string) => void; onChange: () => void; onReply: (text: string) => void }) {
  const failed = m.status === "failed" || m.stale;
  if (m.status === "working" && !m.parts.length && !m.stale)
    return (
      <span role="status" aria-label="Working" className="inline-flex text-primary-text">
        <Loader size={16} strokeWidth={2} className="animate-spin" />
      </span>
    );
  return (
    <div className="flex flex-col gap-2.5 text-base leading-[1.6]">
      {m.text && !(failed && !m.parts.length) ? <Paragraphs text={m.text} /> : null}
      {m.parts.map((p, j) => {
        switch (p.kind) {
          case "company": {
            const d = view.drafts[p.planId];
            return d ? <CompanyReply key={j} view={d} live={live} busy={busy} onApply={() => onApply(p.planId)} onChange={onChange} /> : null;
          }
          case "status":
            return (
              <div key={j} className="flex flex-col gap-2.5">
                <StatusTable head="Part" rows={p.rows} statusWidth="110px" />
                {p.note && m.status === "working" ? <span className="text-[15px] text-muted">{p.note}</span> : null}
              </div>
            );
          case "text":
            return (
              <div key={j} className={cn(p.muted && "text-[15px] text-muted")}>
                {p.text}
              </div>
            );
          case "buttons":
            return (
              <div key={j} className="flex flex-col items-start gap-2">
                {p.buttons.map((b) => (
                  <Button key={b.label} disabled={!live || busy} onClick={() => onReply(b.label)}>
                    {b.label}
                  </Button>
                ))}
              </div>
            );
          default:
            return null;
        }
      })}
      {failed && !m.parts.length ? <Paragraphs text={m.stale ? STOPPED : m.text} /> : null}
    </div>
  );
}

function Panel({ view }: { view: CompanyRulesView }) {
  return (
    <div className="flex w-[560px] shrink-0 flex-col overflow-hidden border-l border-line bg-white">
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-6">
        <span className="flex-1 text-[15px] font-semibold">How {view.company} works across apps</span>
        <span className="text-[13.5px] text-muted">{view.panel.line}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-6 pt-1.5 pb-6 text-[15.5px] leading-[1.75] text-nav">
        {view.panel.rules.length ? (
          <section>
            <div className="pt-3 font-semibold text-ink">Company rules</div>
            {view.panel.rules.map((r) => (
              <div key={r.id} className={cn("-mx-2 mt-1 rounded-[6px] px-2 py-1", r.marked && "bg-primary-light")}>
                <div className="text-ink">{r.text}</div>
                <div className="text-[14.5px] text-muted">Applies to: {r.appliesTo}</div>
              </div>
            ))}
          </section>
        ) : (
          <div className="pt-3 text-muted">A company rule applies across apps: say it once, and Bike adds it wherever it fits. Each app&apos;s Customize text lists the ones that apply to it.</div>
        )}
      </div>
    </div>
  );
}

export function CompanyRulesTab({ initial }: { initial: CompanyRulesView }) {
  const model = useModel();
  const [view, setView] = useState(initial);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const r = await loadCompanyRules();
    if (r.ok) setView(r.view);
  }, []);

  useEffect(() => {
    if (!view.working) return;
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [view.working, refresh]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [view.messages.length]);

  const busy = view.working || sending;
  const say = async (message: string) => {
    if (busy || !message.trim()) return;
    setSending(true);
    setError(null);
    const r = await sendToCompanyRules(message);
    setSending(false);
    if (!r.ok) setError(r.error);
    else setText("");
    await refresh();
  };
  const apply = async (planId: string) => {
    if (!view.chatId) return;
    setSending(true);
    setError(null);
    const r = await applyCompanyRulesDraft(view.chatId, planId);
    setSending(false);
    if (!r.ok) setError(r.error);
    await refresh();
  };

  const waiting = Object.values(view.drafts).some((d) => d.state === "waiting");
  const last = view.messages.at(-1);
  const asked = last?.from === "bike" && last.parts.some((p) => p.kind === "buttons");
  const placeholder = view.applying ? "You can keep typing while this finishes…" : waiting ? "Reply to change the preview…" : asked ? "Reply…" : "Describe a rule for the whole company…";

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={scroller} className="min-h-0 flex-1 overflow-auto px-6 pt-6">
          <div className="mx-auto flex max-w-[600px] flex-col gap-[18px] pb-6">
            {view.messages.length === 0 ? (
              <div className="flex flex-col items-center gap-3.5 pt-[120px] text-center">
                <span className="text-xl font-semibold">What should every app follow?</span>
                {model.none ? (
                  <NeedsModel line={NO_MODEL.companyRules} admin={model.admin} className="max-w-[460px]" />
                ) : (
                  <span className="max-w-[460px] text-base leading-[1.55] text-muted">Describe a policy for the whole company in your own words. Bike shows where it applies and what it would have done before anything is live.</span>
                )}
                <div className={model.none ? "hidden" : "mt-1.5 flex flex-wrap justify-center gap-2"}>
                  {view.chips.map((c) => (
                    <button key={c} type="button" disabled={busy} onClick={() => void say(c)} className="inline-flex h-[30px] cursor-pointer items-center rounded-full border border-line bg-white px-3 text-[15px] text-icon hover:bg-page">
                      {c}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {view.messages.map((m, i) => (
              <Fragment key={m.id}>
                {view.dates[m.id] ? <DateLine text={view.dates[m.id]!} /> : null}
                {m.from === "person" ? <Person m={m} /> : <Bike m={m} live={i === view.messages.length - 1} view={view} busy={busy} onApply={(id) => void apply(id)} onChange={() => input.current?.focus()} onReply={(t) => void say(t)} />}
              </Fragment>
            ))}
            {error ? <div className="text-[15px] text-danger">{error}</div> : null}
          </div>
        </div>
        {model.none ? (
          view.messages.length ? (
            <div className="px-6 pt-3 pb-[18px]">
              <NeedsModel line={NO_MODEL.companyRules} admin={model.admin} />
            </div>
          ) : null
        ) : (
          <div className="px-6 pt-3 pb-[18px]">
            <div className="flex items-end gap-2.5 rounded-[12px] border border-line px-3.5 py-3 shadow-[0_1px_2px_rgba(0,0,0,.05)]">
              <MessageBox boxRef={input} label="Message" value={text} placeholder={placeholder} onChange={setText} onSend={() => void say(text)} />
              <button type="button" aria-label="Send" disabled={busy || !text.trim()} onClick={() => void say(text)} className="inline-flex size-[30px] cursor-pointer items-center justify-center rounded-[8px] bg-primary text-white disabled:cursor-default">
                <ArrowUp size={16} strokeWidth={2} />
              </button>
            </div>
          </div>
        )}
      </div>
      <Panel view={view} />
    </div>
  );
}
