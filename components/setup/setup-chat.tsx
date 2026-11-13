"use client";

import { ArrowRight, Download, File, Loader, Paperclip, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { attachSetupFile, continueSetup, finishSetupNow, loadSetup, sendSetup, skipSetupStep } from "@/app/ws/[ws]/setup/actions";
import { Button } from "@/components/buttons";
import { Paragraphs, ReplyTable } from "@/components/chat/parts";
import { BikeMark } from "@/components/logo";
import type { SetupShown, SetupView } from "@/server/setup/view";
import { SetupFrame } from "./setup-frame";
import { NeedsModel } from "@/components/no-model";
import { NO_MODEL } from "@/lib/messages";
import { MessageBox } from "@/components/chat/message-box";

// Setup 2b–2f: a start box per step (2b, 2d), then the conversation with what Bike read (2c, 2e), then the
// summary (2f). While Bike reads a message, the page asks for setup again every second. Column widths are
// the screens' plus the 12 px cell padding.

type Step = "organization" | "team";
type Attached = { uploadId: string; name: string; detail: string };

const START = {
  organization: {
    title: "Tell us about your organization",
    line: "Name, address, website, what it does and what you sell.",
    placeholder: "e.g. “Fernwood Labs, 210 Congress Ave, Austin. fernwood.dev. We build developer tools, Fernwood CI and Fernwood Trace, sold monthly to engineering teams.”",
    skip: "Skip for now",
    opener: "Tell us about your organization.",
    accept: ".pdf",
  },
  team: {
    title: "Tell us about your team",
    line: "Who leads the company, and who reports to whom?",
    placeholder: "e.g. “I’m the founder. Priya leads engineering, Dev leads growth, Krishna runs ops, Lena is our part-time accountant.”",
    skip: "Skip this step, I’ll add people later",
    opener: "Tell us about your team.",
    accept: ".csv,.xlsx",
  },
};

// Files for a message: each is uploaded as it is picked, and Send waits for them.
function useFiles(step: Step) {
  const [files, setFiles] = useState<Attached[]>([]);
  const [uploading, setUploading] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const pick = async (list: FileList | File[] | null) => {
    const picked = Array.from(list ?? []);
    setUploading((n) => n + picked.length);
    for (const f of picked) {
      const form = new FormData();
      form.set("file", f);
      const r = await attachSetupFile(step, form);
      if (r.ok) setFiles((xs) => (step === "team" ? [] : xs).concat({ uploadId: r.uploadId, name: r.name, detail: r.detail }));
      else setProblem(r.error);
      setUploading((n) => n - 1);
    }
  };
  return { files, setFiles, uploading, problem, setProblem, pick };
}

function Chip({ f, onRemove }: { f: Attached; onRemove: () => void }) {
  return (
    <span className="inline-flex h-[26px] items-center gap-1.5 rounded-[4px] bg-fill px-2 text-[13.5px]">
      <Paperclip size={12} strokeWidth={1.8} />
      {f.name} · {f.detail}
      <button type="button" aria-label={`Remove ${f.name}`} className="inline-flex cursor-pointer text-muted" onClick={onRemove}>
        <X size={12} strokeWidth={1.8} />
      </button>
    </span>
  );
}

// 2b and 2d's box: a few lines to type in, a paperclip, the files, and Send.
function StartBox({ step, busy, onSend, files, noModel }: { step: Step; busy: boolean; onSend: (text: string, ids: string[]) => Promise<boolean>; files: ReturnType<typeof useFiles>; noModel: boolean }) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const can = !busy && !files.uploading && (!!text.trim() || files.files.length > 0);
  const send = async () => {
    if (!can) return;
    if (await onSend(text, files.files.map((f) => f.uploadId))) {
      setText("");
      files.setFiles([]);
    }
  };
  return (
    <div className="flex flex-col gap-3 rounded-[12px] border border-line bg-white p-3.5 shadow-[0_2px_8px_rgba(0,0,0,.04)] focus-within:border-primary focus-within:shadow-[0_0_0_3px_#DCEEFF]">
      {noModel ? (
        <p className="m-0 text-[15px] leading-[1.6] text-muted">{NO_MODEL.setup}</p>
      ) : (
        <MessageBox label="Your answer" value={text} placeholder={START[step].placeholder} rows={3} maxRows={10} onChange={setText} onSend={() => void send()} className="flex-none text-[15px] leading-[1.6]" />
      )}
      <div className="flex items-center gap-2">
        <button type="button" aria-label="Attach a file" onClick={() => input.current?.click()} className="inline-flex size-[30px] cursor-pointer items-center justify-center rounded-[6px] border border-line bg-white text-muted hover:text-ink">
          <Paperclip size={14} strokeWidth={1.8} />
        </button>
        <input ref={input} type="file" accept={START[step].accept} hidden onChange={(e) => void files.pick(e.target.files).then(() => (e.target.value = ""))} />
        {files.files.map((f) => (
          <Chip key={f.uploadId} f={f} onRemove={() => files.setFiles((xs) => xs.filter((x) => x.uploadId !== f.uploadId))} />
        ))}
        <span className="flex-1" />
        <button type="button" aria-label="Send" disabled={!can} onClick={() => void send()} className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[6px] bg-primary px-3.5 text-[15px] text-white disabled:cursor-default disabled:opacity-35">
          Send
          <ArrowRight size={14} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}

// 2d's drop box above the start box: drop or choose a team file, or download the template (2g).
function DropBox({ files }: { files: ReturnType<typeof useFiles> }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void files.pick(e.dataTransfer.files);
      }}
      className="flex flex-col items-center gap-2 rounded-[12px] border-[1.5px] border-dashed border-line bg-page p-[22px]"
    >
      <span className="inline-flex text-muted">
        <File size={22} strokeWidth={1.8} />
      </span>
      <span className="text-base font-medium">Drop your team spreadsheet</span>
      <div className="flex gap-2 pt-1">
        <Button onClick={() => input.current?.click()}>Choose a file</Button>
        <input ref={input} type="file" accept=".csv,.xlsx" hidden onChange={(e) => void files.pick(e.target.files).then(() => (e.target.value = ""))} />
        <a href="/setup/template.csv" download className="inline-flex h-8 items-center gap-1.5 px-2.5 text-[15px] font-medium text-primary-deep underline decoration-primary-border underline-offset-[3px]">
          <Download size={14} strokeWidth={1.8} />
          Download CSV template
        </a>
      </div>
    </div>
  );
}

// The one-line reply box under the conversation (2c, 2e).
function ReplyBox({ step, busy, onSend }: { step: Step; busy: boolean; onSend: (text: string, ids: string[]) => Promise<boolean> }) {
  const files = useFiles(step);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const can = !busy && !files.uploading && (!!text.trim() || files.files.length > 0);
  const send = async () => {
    if (!can) return;
    if (await onSend(text, files.files.map((f) => f.uploadId))) {
      setText("");
      files.setFiles([]);
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-line px-3 py-2.5">
      {files.files.length ? (
        <div className="flex flex-wrap gap-1.5">
          {files.files.map((f) => (
            <Chip key={f.uploadId} f={f} onRemove={() => files.setFiles((xs) => xs.filter((x) => x.uploadId !== f.uploadId))} />
          ))}
        </div>
      ) : null}
      <div className="flex items-end gap-2">
        <MessageBox label="Reply" value={text} placeholder="Reply to correct anything…" onChange={setText} onSend={() => void send()} />
        {text.trim() || files.files.length ? (
          <button type="button" aria-label="Send" disabled={!can} onClick={() => void send()} className="inline-flex size-7 cursor-pointer items-center justify-center rounded-[6px] bg-primary text-white disabled:bg-primary-border">
            <ArrowRight size={14} strokeWidth={2} />
          </button>
        ) : null}
        <button type="button" aria-label="Attach a file" onClick={() => input.current?.click()} className="inline-flex cursor-pointer text-muted hover:text-ink">
          <Paperclip size={16} strokeWidth={1.8} />
        </button>
        <input ref={input} type="file" accept={START[step].accept} hidden onChange={(e) => void files.pick(e.target.files).then(() => (e.target.value = ""))} />
      </div>
      {files.problem ? <div className="text-sm text-danger">{files.problem}</div> : null}
    </div>
  );
}

const muted = (s: string) => <span className="text-muted">{s}</span>;

function Reply({ m, busy, act }: { m: SetupShown & { from: "bike" }; busy: boolean; act: { next: () => void } }) {
  if (m.kind === "working")
    return (
      <span className="inline-flex text-primary-text" aria-label="Bike is reading">
        <Loader size={16} strokeWidth={2} className="animate-spin" />
      </span>
    );
  if (m.kind === "failed") return <Paragraphs text={m.text} />;
  if (m.kind === "organization")
    return (
      <>
        <div>{m.text}</div>
        <ReplyTable
          head={["Detail", "What I have"]}
          widths={["182px"]}
          rows={[...m.rows.map(([k, v]) => [k, v ?? muted("Not given yet.")]), ["Legal name and tax ID", muted("Legal name and tax ID aren’t needed for now.")]]}
        />
        {m.missing.map((x) => (
          <div key={x}>{x}</div>
        ))}
        {m.latest ? (
          <div className="flex gap-2">
            <Button kind="primary" disabled={busy} onClick={act.next}>
              Continue to your team
            </Button>
          </div>
        ) : null}
      </>
    );
  return (
    <>
      <div>{m.text}</div>
      <ReplyTable
        head={["Name", "Title", "Reports", "Role"]}
        widths={[undefined, "202px", "92px", "112px"]}
        rows={m.leads.map((l) => [l.name, l.title, l.reports ? String(l.reports) : muted("—"), l.role])}
      />
      {m.problems.map((x) => (
        <div key={x}>{x}</div>
      ))}
      <div>Reply to correct anything, for example “Lena reports to Krishna”.</div>
      {m.latest ? (
        <div className="flex gap-2">
          <Button kind="primary" disabled={busy} onClick={act.next}>
            Finish setup
          </Button>
        </div>
      ) : null}
    </>
  );
}

function Admin({ m }: { m: SetupShown & { from: "admin" } }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-[12px] bg-fill px-3.5 py-2.5 text-base leading-[1.55]">
        {m.files.map((f) => (
          <div key={f.name} className="mb-1 flex items-center gap-1.5">
            <Paperclip size={14} strokeWidth={1.8} />
            {f.name}
          </div>
        ))}
        {m.text}
      </div>
    </div>
  );
}

// noModel (O3, f-setup-no-model): nothing typed can be read, so the steps can be skipped; a team file still works.
export function SetupChat({ initial, address, noModel = false }: { initial: SetupView; address: string; noModel?: boolean }) {
  const [view, setView] = useState(initial);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const step: Step = view.step === "done" ? "team" : view.step;
  const files = useFiles(step);

  const refresh = useCallback(async () => {
    const r = await loadSetup();
    if (r.ok) setView(r.view);
  }, []);
  const working = view.step !== "done" && view.working;
  useEffect(() => {
    if (!working) return;
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [working, refresh]);

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setSending(true);
    setError(null);
    const r = await fn();
    setSending(false);
    if (!r.ok) setError(r.error ?? null);
    await refresh();
    return r.ok;
  };
  const say = (text: string, ids: string[]) => run(() => sendSetup(step, text, ids));
  const busy = sending || working;
  const errorLine = error || files.problem ? <div className="text-sm text-danger">{error ?? files.problem}</div> : null;

  if (view.step === "done")
    return (
      <SetupFrame step={4} company={{ name: view.name, address }}>
        <Column>
          <div className="flex flex-col gap-2.5 text-base leading-[1.6]">
            <div>
              <b className="font-semibold">{view.name} is set up.</b> {view.people === 1 ? "You are in People." : `Your ${view.people} people are in People.`} There are no apps yet: on Home, describe what you want to run, and Bike builds it.
            </div>
            {view.leftOut.length ? <div>{`${list(view.leftOut)} ${view.leftOut.length === 1 ? "has" : "have"} no work email yet, so ${view.leftOut.length === 1 ? "isn’t" : "aren’t"} in People. Add them in People.`}</div> : null}
            {view.noManager.length ? <div>{`${list(view.noManager)} ${view.noManager.length === 1 ? "has" : "have"} no manager in People yet, because their manager has no work email. Set it in People.`}</div> : null}
            <ReplyTable
              head={["Setup", "Detail"]}
              widths={["182px"]}
              rows={[
                ["Organization", view.organization],
                ["Team", view.team],
                ["Address", address],
              ]}
            />
            <div className="flex gap-2">
              <a href="/home" className="inline-flex h-9 items-center rounded-[6px] bg-primary px-4 text-[15px] font-medium text-white hover:bg-primary-hover">
                Go to Home
              </a>
            </div>
          </div>
        </Column>
      </SetupFrame>
    );

  const frame = (children: React.ReactNode) => (
    <SetupFrame step={view.step === "organization" ? 2 : 3} company={{ name: view.name, address }}>
      {children}
    </SetupFrame>
  );

  if (!view.messages.length)
    return frame(
      <Column gap={20}>
        <div className="flex flex-col items-center gap-3 pt-6 text-center">
          <BikeMark size={40} />
          <h1 className="m-0 text-2xl font-semibold tracking-[-0.01em]">{START[step].title}</h1>
          <p className="m-0 max-w-[520px] text-[15px] leading-[1.55] text-muted">{START[step].line}</p>
        </div>
        {step === "team" ? (
          <>
            <DropBox files={files} />
            <div className="flex items-center gap-2.5 text-[15px] text-muted">
              <span className="h-px flex-1 bg-line" />
              or tell us
              <span className="h-px flex-1 bg-line" />
            </div>
          </>
        ) : null}
        {noModel && step === "organization" ? (
          <NeedsModel line={NO_MODEL.setup} admin={false} />
        ) : (
          <StartBox step={step} busy={busy} onSend={say} files={files} noModel={noModel} />
        )}
        {errorLine}
        <div className="flex justify-center">
          <button type="button" disabled={busy} onClick={() => void run(() => skipSetupStep(step))} className="cursor-pointer text-[15px] text-muted hover:text-ink">
            {START[step].skip}
          </button>
        </div>
      </Column>,
    );

  const next = () => void run(step === "organization" ? continueSetup : finishSetupNow);
  return frame(
    <Column>
      <div className="text-base leading-[1.6]">{START[step].opener}</div>
      {view.messages.map((m, i) =>
        m.from === "admin" ? (
          <Admin key={i} m={m} />
        ) : (
          <div key={i} className="flex flex-col gap-2.5 text-base leading-[1.6]">
            <Reply m={m} busy={busy} act={{ next }} />
          </div>
        ),
      )}
      {noModel ? <NeedsModel line={NO_MODEL.setup} admin={false} /> : <ReplyBox step={step} busy={busy} onSend={say} />}
      {errorLine}
      {/* A reply that failed (no model, or the model refused) never strands the admin: the step can still be skipped. */}
      {view.messages.at(-1)?.from !== "admin" && (view.messages.at(-1) as { kind?: string } | undefined)?.kind === "failed" ? (
        <div className="flex justify-center">
          <button type="button" disabled={busy} onClick={() => void run(() => skipSetupStep(step))} className="cursor-pointer text-[15px] text-muted hover:text-ink">
            {START[step].skip}
          </button>
        </div>
      ) : null}
    </Column>,
  );
}

function Column({ children, gap = 18 }: { children: React.ReactNode; gap?: number }) {
  return (
    <div className="flex justify-center">
      <div className="box-border flex w-[680px] max-w-full flex-col px-6 py-10" style={{ gap }}>
        {children}
      </div>
    </div>
  );
}

const list = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
