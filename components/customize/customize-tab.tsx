"use client";

import { ArrowUp, Loader } from "lucide-react";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { applyCustomizeDraft, loadCustomize, sendToCustomize } from "@/app/ws/[ws]/(app)/c/[cap]/customize-actions";
import { Button } from "@/components/buttons";
import { DateLine, Paragraphs, ReplyTable, StatusTable } from "@/components/chat/parts";
import { cn } from "@/lib/utils";
import type { Via } from "@/server/chat/customize";
import type { CustomizeView } from "@/server/chat/customize-view";
import { AdviceReply } from "./advice";
import { ChangeReply } from "./change-reply";
import { TextPanel } from "./text-panel";
import { MessageBox } from "@/components/chat/message-box";
import { NeedsModel, useModel } from "@/components/no-model";
import { NO_MODEL } from "@/lib/messages";

// The Customize tab (6b–6l): the capability's own chat on the left and how it works as plain text on the
// right. No popup and no Edit button: the admin says what should change, sees the preview, and clicks Apply.
// While Bike works, the page asks for the chat again every second.

const STOPPED = "That stopped before it finished. Try again.";
// Where a button's message goes; buttons from before C2 ("reply") are as if typed.
const VIA: Record<string, Via> = { plan: "plan", explain: "explain", do_it: "do_it", explain_first: "explain_first" };

type Shown = CustomizeView["messages"][number];

function Person({ m }: { m: Shown }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-[12px] bg-fill px-3.5 py-2.5 text-base leading-[1.55]">{m.text}</div>
    </div>
  );
}

// ask: words to start the message box with (the table's "+" for a column, T1); nothing is sent until the admin sends it.
export function CustomizeTab({ initial, people, ask }: { initial: CustomizeView; people: { name: string; tint: string }[]; ask?: string }) {
  const model = useModel();
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [text, setText] = useState(ask ?? "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const tints = new Map(people.map((p) => [p.name, p.tint]));

  const refresh = useCallback(async () => {
    const r = await loadCustomize(view.capabilityId);
    if (r.ok) setView(r.view);
  }, [view.capabilityId]);

  useEffect(() => {
    if (!view.working) return;
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [view.working, refresh]);

  // A change applied shows its new version everywhere (the header, the Data tab, the sidebar).
  const wasApplying = useRef(view.applying);
  useEffect(() => {
    if (wasApplying.current && !view.applying) router.refresh();
    wasApplying.current = view.applying;
  }, [view.applying, router]);

  // To the bottom when a message comes, and again when the last one is filled in (a guide answer, C2).
  const lastFilled = `${view.messages.length}:${view.messages.at(-1)?.status}`;
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [lastFilled]);

  const busy = view.working || sending;
  const say = async (message: string, via: Via = "typed") => {
    if (busy || !message.trim()) return;
    setSending(true);
    setError(null);
    const r = await sendToCustomize(view.capabilityId, message, via);
    setSending(false);
    if (!r.ok) setError(r.error);
    else setText("");
    await refresh();
  };
  const apply = async (planId: string) => {
    if (!view.chatId) return;
    setSending(true);
    setError(null);
    const r = await applyCustomizeDraft(view.chatId, planId);
    setSending(false);
    if (!r.ok) setError(r.error);
    await refresh();
  };

  const last = view.messages.at(-1);
  // The text on the right points at the part the latest answer explains (C2), until the chat moves on.
  const lastGuide = last?.from === "bike" ? last.parts.find((p) => p.kind === "guide") : undefined;
  const highlight = lastGuide?.kind === "guide" ? lastGuide.section : null;
  const waiting = Object.values(view.drafts).some((d) => d.state === "waiting");
  const asked = last?.from === "bike" && last.parts.some((p) => p.kind === "buttons");
  const placeholder = view.applying ? "You can keep typing while this finishes…" : waiting ? "Reply to change the preview…" : asked ? "Reply…" : "Tell Bike what to change…";

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={scroller} className="min-h-0 flex-1 overflow-auto px-6 pt-6">
          <div className="mx-auto flex max-w-[600px] flex-col gap-[18px] pb-6">
            {view.messages.length === 0 ? (
              <div className="flex flex-col items-center gap-3.5 pt-[120px] text-center">
                <span className="text-xl font-semibold">What should change in {view.name}?</span>
                {model.none ? (
                  <NeedsModel line={NO_MODEL.customize} admin={model.admin} className="max-w-[440px]" />
                ) : (
                  <span className="max-w-[440px] text-base leading-[1.55] text-muted">Describe it in your own words. Bike shows how it will read on the right before anything is live.</span>
                )}
                {view.chips.length && !model.none ? (
                  <div className="mt-1.5 flex flex-wrap justify-center gap-2">
                    {view.chips.map((c) => (
                      <button key={c} type="button" disabled={busy} onClick={() => void say(c)} className="inline-flex h-[30px] cursor-pointer items-center rounded-full border border-line bg-white px-3 text-[15px] text-icon hover:bg-page">
                        {c}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {view.messages.map((m, i) => (
              <Fragment key={m.id}>
                {view.dates[m.id] ? <DateLine text={view.dates[m.id]!} /> : null}
                {m.from === "person" ? (
                  <Person m={m} />
                ) : (
                  <Bike m={m} live={i === view.messages.length - 1} view={view} busy={busy} tints={tints} onApply={(id) => void apply(id)} onChange={() => input.current?.focus()} onReply={(t, via) => void say(t, via)} />
                )}
              </Fragment>
            ))}
            {error ? <div className="text-[15px] text-danger">{error}</div> : null}
          </div>
        </div>
        {model.none ? (
          view.messages.length ? (
            <div className="px-6 pt-3 pb-[18px]">
              <NeedsModel line={NO_MODEL.customize} admin={model.admin} />
            </div>
          ) : null
        ) : (
          <div className="px-6 pt-3 pb-[18px]">
            <div className="flex items-end gap-2.5 rounded-[12px] border border-line px-3.5 py-3 shadow-[0_1px_2px_rgba(0,0,0,.05)]">
              <MessageBox boxRef={input} label="Message" value={text} placeholder={placeholder} onChange={setText} onSend={() => void say(text)} />
              <button
                type="button"
                aria-label="Send"
                disabled={busy || !text.trim()}
                onClick={() => void say(text)}
                className="inline-flex size-[30px] cursor-pointer items-center justify-center rounded-[8px] bg-primary text-white disabled:cursor-default"
              >
                <ArrowUp size={16} strokeWidth={2} />
              </button>
            </div>
          </div>
        )}
      </div>
      <TextPanel name={view.name} line={view.panel.line} sections={view.panel.sections} picture={view.panel.picture} highlight={highlight} />
    </div>
  );
}

function Bike({
  m,
  live,
  view,
  busy,
  tints,
  onApply,
  onChange,
  onReply,
}: {
  m: Shown;
  live: boolean;
  view: CustomizeView;
  busy: boolean;
  tints: Map<string, string>;
  onApply: (planId: string) => void;
  onChange: () => void;
  onReply: (text: string, via: Via) => void;
}) {
  const failed = m.status === "failed" || m.stale;
  if (m.status === "working" && !m.parts.length && !m.stale)
    return (
      <span role="status" aria-label="Working" className="inline-flex text-primary-text">
        <Loader size={16} strokeWidth={2} className="animate-spin" />
      </span>
    );
  return (
    <div className="flex flex-col gap-2.5 text-base leading-[1.6]">
      {m.parts.some((p) => p.kind === "guide") ? <span className="text-[13.5px] text-muted">Explaining · nothing changed</span> : null}
      {m.parts.some((p) => p.kind === "advice") ? <span className="text-[13.5px] text-muted">Advice · nothing changed</span> : null}
      {m.text && !(failed && !m.parts.length) ? <Paragraphs text={m.text} /> : null}
      {m.parts.map((p, j) => {
        switch (p.kind) {
          case "change": {
            const d = view.drafts[p.planId];
            return d ? <ChangeReply key={j} view={d} live={live} busy={busy} tints={tints} onApply={() => onApply(p.planId)} onChange={onChange} /> : null;
          }
          case "status":
            return (
              <div key={j} className="flex flex-col gap-2.5">
                <StatusTable head="Part" rows={p.rows} statusWidth="110px" />
                {p.note && m.status === "working" ? <span className="text-[15px] text-muted">{p.note}</span> : null}
              </div>
            );
          // C2: a guide answer says so before its text, which comes first in the message.
          case "guide":
            return null;
          case "advice":
            return <AdviceReply key={j} advice={p} />;
          case "table":
            return <ReplyTable key={j} head={p.columns} rows={p.rows} />;
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
                  <Button key={b.label} disabled={!live || busy} onClick={() => onReply(b.label, VIA[b.action] ?? "typed")} className="h-auto min-h-9 max-w-full py-1.5 text-left whitespace-normal">
                    {b.label}
                  </Button>
                ))}
              </div>
            );
          case "link":
            return (
              <div key={j}>
                <a href={p.href} className="inline-flex h-9 items-center rounded-[6px] border border-line bg-white px-3.5 text-[15px] font-medium shadow-[0_1px_2px_rgba(0,0,0,.05)] hover:bg-page">
                  {p.label}
                </a>
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
