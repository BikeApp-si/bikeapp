"use client";

import { ArrowRight, Paperclip, X } from "lucide-react";
import { MESSAGE_FILES } from "@/lib/accept";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { attachFile, sendMessage } from "@/app/ws/[ws]/(app)/home/actions";
import { MessageBox } from "@/components/chat/message-box";

// 3a / 5a / 12a: the admin's box on Home. Sending starts a chat and opens it on Home.

// into: a capability to import a spreadsheet into (5i's Import a spreadsheet); the box then asks for the file.
// ask: a request filled in from elsewhere (Customize advice, C3); it waits in the box until the admin sends it.
export function HomeBox({ empty, chips, into, ask = "" }: { empty: boolean; chips: string[]; into?: { id: string; name: string }; ask?: string }) {
  const router = useRouter();
  const [text, setText] = useState(ask);
  const [files, setFiles] = useState<{ uploadId: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const [uploading, setUploading] = useState(0);
  // A message waits for its files: Send stays off until each one is uploaded.
  const pick = async (list: FileList | null) => {
    const picked = Array.from(list ?? []);
    setUploading((n) => n + picked.length);
    for (const f of picked) {
      const form = new FormData();
      form.set("file", f);
      const r = await attachFile(form);
      if (r.ok) setFiles((xs) => [...xs, { uploadId: r.uploadId, name: r.name }]);
      else setProblem(r.error);
      setUploading((n) => n - 1);
    }
    if (input.current) input.current.value = "";
  };

  const send = async () => {
    if (busy || uploading || (!text.trim() && !files.length)) return;
    setBusy(true);
    const r = await sendMessage(null, text, files.map((f) => f.uploadId), into?.id);
    if (r.ok) router.push(`/home?chat=${r.chatId}`);
    else {
      setBusy(false);
      setProblem(r.error);
    }
  };

  return (
    <>
      <div className="flex w-[720px] max-w-full flex-col gap-2.5 rounded-[12px] border border-line bg-white px-3.5 py-3 shadow-[0_1px_2px_rgba(0,0,0,.05)] focus-within:shadow-[0_0_0_3px_#F1F5F9]">
        <MessageBox
          label={empty ? "Describe a process or record" : "Ask about your data"}
          placeholder={
            into ? `Attach the spreadsheet to import into ${into.name}…` : empty ? "Describe a process or record you want to manage, and Bike builds it…" : "Ask about your data, or describe what you need…"
          }
          rows={2}
          maxRows={8}
          value={text}
          onChange={setText}
          onSend={() => void send()}
          className="flex-none placeholder:text-[#90A1B9]"
        />
        {files.length ? (
          <div className="flex flex-wrap gap-1.5">
            {files.map((f) => (
              <span key={f.uploadId} className="inline-flex h-7 items-center gap-1.5 rounded-[6px] bg-fill px-2 text-sm text-nav">
                <Paperclip size={13} strokeWidth={1.8} />
                {f.name}
                <button type="button" aria-label={`Remove ${f.name}`} className="cursor-pointer text-muted" onClick={() => setFiles((xs) => xs.filter((x) => x.uploadId !== f.uploadId))}>
                  <X size={13} strokeWidth={1.8} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="flex items-center gap-2 text-muted">
          <button type="button" aria-label="Attach a file" className="inline-flex cursor-pointer hover:text-ink" onClick={() => input.current?.click()}>
            <Paperclip size={15} strokeWidth={1.8} />
          </button>
          <input ref={input} type="file" accept={into ? ".csv" : MESSAGE_FILES} multiple={!into} hidden onChange={(e) => void pick(e.target.files)} />
          <span className="flex-1" />
          {text.trim() || files.length ? (
            <button
              type="button"
              aria-label="Send"
              disabled={busy || uploading > 0}
              onClick={() => void send()}
              className="inline-flex size-8 cursor-pointer items-center justify-center rounded-[8px] bg-primary text-white disabled:bg-primary-border"
            >
              <ArrowRight size={16} strokeWidth={2} />
            </button>
          ) : null}
        </div>
      </div>
      {problem ? <div className="text-[15px] text-danger">{problem}</div> : null}
      {empty && chips.length ? (
        <div className="mx-auto flex max-w-[640px] flex-wrap justify-center gap-1.5 pt-3">
          {chips.map((c) => (
            <button key={c} type="button" onClick={() => setText(c)} className="h-9 cursor-pointer rounded-full border border-line bg-white px-3.5 text-[15px] text-muted hover:text-ink">
              {c}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
