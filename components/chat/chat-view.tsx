"use client";

import { SystemIcon } from "@/components/shell/system-icon";
import { TopBar } from "@/components/shell/top-bar";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { answerBuildQuestion, buildAll, createFromPlan, importFromChat, loadChat, runReportAgain, sendMessage } from "@/app/ws/[ws]/(app)/home/actions";
import { Button } from "@/components/buttons";
import type { Message } from "@/server/kernel/chats";
import type { ChatView as View, PlanView } from "@/server/chat/view";
import { Composer } from "./composer";
import { ImportReply, ImportRowsReply } from "./import-reply";
import { PlanPanel } from "./plan-panel";
import { ReportPanel } from "./report-panel";
import { ReportReply } from "./report-reply";
import { PlanReply, type PlanActions, type PlanMode } from "./plan-reply";
import { Check } from "lucide-react";
import { DateLine, FileChip, Paragraphs, ReplyTable, StatusTable } from "./parts";
import { NeedsModel, useModel } from "@/components/no-model";
import { NO_MODEL } from "@/lib/messages";

// One chat on Home (5b–5l): the messages, the plan side panel, and the box at the bottom. While Bike works,
// the page asks for the chat again every second.

const STOPPED = "That stopped before it finished. Try again.";

type Shown = View["messages"][number];

function modeOf(view: View, i: number, plan: PlanView): PlanMode {
  if (plan.status === "replaced") return "replaced";
  const later = view.messages.slice(i + 1);
  if (plan.status === "created" || later.some((m) => m.parts.some((p) => p.kind === "creating" && p.planId === plan.id))) return "created";
  return later.length ? "collapsed" : "full";
}

// Column widths for the build's tables, as 4b and 4d draw them.
function widthsFor(columns: string[]): (string | undefined)[] {
  if (columns[0] === "#") return ["40px", "162px", undefined, "202px"];
  if (columns[1] === "Sheets") return [undefined, "92px", "92px", "102px"];
  if (columns[0] === "Item") return ["262px"];
  return [];
}

type LinkPart = Extract<Message["parts"][number], { kind: "link" }>;
function linksFrom(parts: Message["parts"], from: number): LinkPart[] {
  const out: LinkPart[] = [];
  for (let i = from; parts[i]?.kind === "link"; i++) out.push(parts[i] as LinkPart);
  return out;
}

function Person({ m }: { m: Message }) {
  const files = m.parts.filter((p) => p.kind === "file");
  return (
    <div className="flex justify-end">
      <div className="max-w-[668px] rounded-[12px] bg-fill px-3.5 py-2.5 text-base leading-[1.55]">
        {files.length ? (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {files.map((f) => (f.kind === "file" ? <FileChip key={f.uploadId} name={f.name} detail={f.detail} /> : null))}
          </div>
        ) : null}
        {m.text}
      </div>
    </div>
  );
}

function Bike({ m, i, view, act, reply, importRows }: { m: Shown; i: number; view: View; act: PlanActions; reply: (text: string) => void; importRows: (messageId: string, label: string) => void }) {
  const failed = m.status === "failed" || m.stale;
  const last = i === view.messages.length - 1;
  // A build chat's earlier reply, once the chat has moved on (4c, 4d).
  const collapsed = m.parts.find((p) => p.kind === "collapsed");
  if (collapsed && !last) return <div className="text-base leading-[1.55]">{collapsed.text}</div>;
  return (
    <div className="flex flex-col gap-3 text-base leading-[1.55]">
      {m.parts.map((p, j) => {
        switch (p.kind) {
          case "plan": {
            const plan = view.plans[p.planId];
            return plan ? <PlanReply key={j} plan={plan} mode={modeOf(view, i, plan)} act={act} /> : null;
          }
          case "import": {
            const plan = view.plans[p.planId];
            return plan ? <ImportReply key={j} plan={plan} act={act} live={last && plan.status === "waiting"} /> : null;
          }
          case "import_rows":
            return <ImportRowsReply key={j} part={p} live={last} busy={act.busy} onImport={(label) => importRows(m.id, label)} />;
          default:
            return null;
        }
      })}
      {m.text && !failed ? <Paragraphs text={m.text} /> : null}
      {m.parts.map((p, j) =>
        p.kind === "status" ? (
          <div key={j} className="flex flex-col gap-2.5">
            <StatusTable head={p.head} rows={p.rows} />
            {p.note && m.status === "working" ? <span className="text-[15.5px] text-muted">{p.note}</span> : null}
          </div>
        ) : p.kind === "link" ? (
          // Links side by side ("Open Customer contracts", "Go to Home"), drawn once from the first.
          m.parts[j - 1]?.kind === "link" ? null : (
            <div key={j} className="flex flex-wrap gap-2">
              {linksFrom(m.parts, j).map((l) => (
                <a
                  key={l.href}
                  href={l.href}
                  className={
                    l.outline
                      ? "inline-flex h-9 items-center rounded-[6px] border border-line bg-white px-3.5 text-[15px] font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,.05)] hover:bg-page"
                      : "inline-flex h-9 items-center rounded-[6px] bg-primary px-4 text-[15px] font-medium text-white hover:bg-primary-hover"
                  }
                >
                  {l.label}
                </a>
              ))}
            </div>
          )
        ) : p.kind === "report" && view.reports[p.reportId] ? (
          <ReportReply key={j} report={view.reports[p.reportId]!} brief={p.brief} opened={act.openReport === p.reportId} open={() => act.showReport?.(p.reportId)} />
        ) : p.kind === "heading" ? (
          <div key={j} className="mt-1 font-semibold">
            {p.text}
          </div>
        ) : p.kind === "text" ? (
          <span key={j} className={p.muted ? "text-muted" : undefined}>
            <Paragraphs text={p.text} />
          </span>
        ) : p.kind === "table" ? (
          <ReplyTable key={j} head={p.columns} rows={p.rows} widths={widthsFor(p.columns)} />
        ) : p.kind === "buttons" ? (
          <div key={j} className="flex flex-wrap gap-2">
            {p.buttons.map((b) =>
              b.action === "build" ? (
                // Build all (4b): the click is the admin's go-ahead; nothing is set up before it.
                <Button key={b.label} kind="primary" disabled={!last || !act.build || act.busy} onClick={() => act.build?.(b.label)}>
                  <Check size={16} strokeWidth={2} />
                  {b.label}
                </Button>
              ) : b.action.startsWith("answer:") ? (
                // 4c's one question: either answer goes on with the build.
                <Button key={b.label} kind={b.primary ? "primary" : "outline"} disabled={!last || act.busy} onClick={() => act.answer?.(Number(b.action.slice(7)))}>
                  {b.label}
                </Button>
              ) : (
                <Button key={b.label} disabled={!last} onClick={() => reply(b.label)}>
                  {b.label}
                </Button>
              ),
            )}
          </div>
        ) : null,
      )}
      {failed ? <Paragraphs text={m.stale ? STOPPED : m.text} /> : null}
    </div>
  );
}

// openReport: a report of this chat to open in the panel at once (from Reports, or a scheduled report's email).
export function ChatView({ initial, openReport: opening }: { initial: View; openReport?: string }) {
  const router = useRouter();
  const model = useModel();
  const [view, setView] = useState(initial);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openReport, setOpenReport] = useState<string | null>(opening && initial.reports[opening] ? opening : null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const done = useRef(new Set(initial.messages.filter((m) => m.status !== "working").map((m) => m.id)));
  const built = useRef(0);

  const refresh = useCallback(async () => {
    const r = await loadChat(view.id);
    if (!r.ok) return;
    setView(r.view);
    // A capability that was just created shows in the sidebar, as does each one a build finishes (4c).
    const finished = r.view.messages.filter((m) => m.status === "done" && !done.current.has(m.id));
    finished.forEach((m) => done.current.add(m.id));
    const builtNow = r.view.messages.flatMap((m) => m.parts).filter((p) => p.kind === "status" && p.head === "Capability").flatMap((p) => (p.kind === "status" ? p.rows : [])).filter((x) => x.state === "done").length;
    const builtMore = builtNow > built.current;
    built.current = builtNow;
    if (builtMore || finished.some((m) => m.parts.some((p) => p.kind === "link"))) router.refresh();
  }, [view.id, router]);

  useEffect(() => {
    if (!view.working) return;
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [view.working, refresh]);

  // New messages scroll the chat, never the page around it.
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [view.messages.length]);

  const say = async (text: string, uploadIds: string[] = []) => {
    setSending(true);
    setError(null);
    const r = await sendMessage(view.id, text, uploadIds);
    setSending(false);
    if (!r.ok) setError(r.error);
    await refresh();
    return r.ok;
  };

  const act: PlanActions = {
    openId,
    openReport,
    showReport: (id) => setOpenReport(id),
    open: (id) => setOpenId(id),
    busy: view.working || sending,
    build: async (label) => {
      setSending(true);
      const r = await buildAll(view.id, label);
      setSending(false);
      if (!r.ok) setError(r.error);
      await refresh();
    },
    answer: async (choice) => {
      setSending(true);
      const r = await answerBuildQuestion(view.id, choice);
      setSending(false);
      if (!r.ok) setError(r.error);
      await refresh();
    },
    create: async (plan, opts) => {
      setSending(true);
      setOpenId(null);
      const r = await createFromPlan(view.id, plan.id, opts.label, { withImport: opts.withImport, withoutRestructure: opts.withoutRestructure });
      setSending(false);
      if (!r.ok) setError(r.error);
      await refresh();
    },
  };

  // 5i's Import a spreadsheet: the rows come in at once; the new capability's rows show in the sidebar count.
  const importRows = async (messageId: string, label: string) => {
    setSending(true);
    const r = await importFromChat(view.id, messageId, label);
    setSending(false);
    if (!r.ok) setError(r.error);
    await refresh();
    router.refresh();
  };

  const creating = view.messages.some((m) => m.status === "working" && m.parts.some((p) => p.kind === "creating" || (p.kind === "status" && p.head === "Part")));
  const waiting = Object.values(view.plans).some((p) => p.status === "waiting");
  // A build chat (4a–4b) is about its plan from the first reply on.
  const placeholder = creating
    ? "You can keep chatting while this finishes…"
    : view.kind === "build" || waiting
      ? "Reply to change the plan…"
      : view.kind === "report" && !view.working
        ? "Ask about your data, or change this report…"
      : view.working
        ? "You can type while I work…"
        : "Ask about your data, or describe what you need…";
  const open = openId ? view.plans[openId] : null;

  return (
    <div className="relative flex h-screen min-h-0 flex-1 flex-col">
      <TopBar title="Home" icon={<SystemIcon page="home" />} />
      <div ref={scroller} className="flex-1 overflow-auto">
        <div className="mx-auto flex max-w-[848px] flex-col gap-[18px] px-6 py-8">
          {view.messages.map((m, i) => (
            <Fragment key={m.id}>
              {view.dates[m.id] ? <DateLine text={view.dates[m.id]!} /> : null}
              {m.from === "person" ? <Person m={m} /> : <Bike m={m} i={i} view={view} act={act} reply={(t) => void say(t)} importRows={(id, label) => void importRows(id, label)} />}
            </Fragment>
          ))}
          {error ? <div className="text-[15px] text-danger">{error}</div> : null}
        </div>
      </div>
      <div className="px-6 pt-3 pb-5">
        {model.none ? <NeedsModel line={NO_MODEL.home} admin={model.admin} /> : <Composer placeholder={placeholder} canSend={!view.working && !sending} onSend={say} />}
      </div>
      {open ? <PlanPanel plan={open} onClose={() => setOpenId(null)} /> : null}
      {openReport && view.reports[openReport] ? (
        <ReportPanel
          report={view.reports[openReport]!}
          changed={!!view.changed[openReport]}
          busy={view.working || sending}
          onClose={() => setOpenReport(null)}
          onRunAgain={async () => {
            setOpenReport(null);
            setSending(true);
            const r = await runReportAgain(view.id, openReport);
            setSending(false);
            if (!r.ok) setError(r.error);
            await refresh();
          }}
        />
      ) : null}
    </div>
  );
}
