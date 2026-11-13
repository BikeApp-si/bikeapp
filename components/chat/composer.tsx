"use client";

import { MESSAGE_FILES } from "@/lib/accept";
import { ArrowRight, Paperclip, X } from "lucide-react";
import { useRef, useState } from "react";
import { attachFile } from "@/app/ws/[ws]/(app)/home/actions";
import { MessageBox } from "./message-box";

// The box at the bottom of a chat: a reply, and files to attach (a CSV to import, a policy to read).

type Attached = { uploadId: string; name: string };

export function Composer({ placeholder, canSend, onSend }: { placeholder: string; canSend: boolean; onSend: (text: string, uploadIds: string[]) => Promise<boolean> }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Attached[]>([]);
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
    if (!canSend || uploading || (!text.trim() && !files.length)) return;
    if (await onSend(text, files.map((f) => f.uploadId))) {
      setText("");
      setFiles([]);
      setProblem(null);
    }
  };

  return (
    <div className="mx-auto flex max-w-[800px] flex-col gap-2 rounded-[12px] border border-line px-3.5 py-2.5 shadow-[0_1px_2px_rgba(0,0,0,.05)]">
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
      <div className="flex items-end gap-2.5">
        <button type="button" aria-label="Attach a file" className="inline-flex cursor-pointer text-muted hover:text-ink" onClick={() => input.current?.click()}>
          <Paperclip size={16} strokeWidth={1.8} />
        </button>
        <input ref={input} type="file" accept={MESSAGE_FILES} multiple hidden onChange={(e) => void pick(e.target.files)} />
        <MessageBox label="Message" value={text} placeholder={placeholder} onChange={setText} onSend={() => void send()} />
        {text.trim() || files.length ? (
          <button
            type="button"
            aria-label="Send"
            disabled={!canSend || uploading > 0}
            onClick={() => void send()}
            className="inline-flex size-8 cursor-pointer items-center justify-center rounded-[8px] bg-primary text-white disabled:bg-primary-border"
          >
            <ArrowRight size={16} strokeWidth={2} />
          </button>
        ) : null}
      </div>
      {problem ? <div className="text-sm text-danger">{problem}</div> : null}
    </div>
  );
}
