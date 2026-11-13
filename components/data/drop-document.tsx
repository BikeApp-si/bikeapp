"use client";

import { Loader, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { readIntoForm, uploadFile } from "@/app/ws/[ws]/(app)/c/[cap]/actions";
import { cn } from "@/lib/utils";
import { useModel } from "@/components/no-model";
import { NO_MODEL } from "@/lib/messages";

// 7c: drop a document on a new row's form (a signed contract); an AI step reads it into the fields below and
// the person checks them before creating. Nothing is saved here.
export function DropDocument({
  capId,
  sheetId,
  what,
  onFilled,
}: {
  capId: string;
  sheetId: string;
  what: string; // the file column, in lower case: "signed contract"
  onFilled: (values: Record<string, unknown>, file: { id: string; name: string }) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const model = useModel();
  // No model (O3): the place stays, saying what it would need; the form's own file question still takes the file.
  if (model.none)
    return (
      <div className="-mx-6 flex items-center gap-3 border-b border-line px-6 py-3">
        <span className="inline-flex shrink-0 text-icon">
          <Upload size={18} strokeWidth={1.8} />
        </span>
        <span className="flex flex-col leading-[1.4]">
          <span className="text-[14.5px] font-medium text-muted">Drop the {what}</span>
          <span className="text-[14px] text-muted">{NO_MODEL.any}</span>
        </span>
      </div>
    );

  const read = async (file: File | undefined) => {
    if (!file || reading) return;
    setReading(file.name);
    setNote(null);
    const form = new FormData();
    form.set("file", file);
    const up = await uploadFile(form);
    if (!up.ok) {
      setReading(null);
      setNote(up.error);
      return;
    }
    const r = await readIntoForm(capId, sheetId, up.id).catch(() => ({ ok: false as const, error: "Bike couldn't read that document just now. Try again in a moment." }));
    setReading(null);
    if (!r.ok) return setNote(r.error);
    onFilled(r.values, { id: up.id, name: up.name });
    setNote(r.unread.length ? `Check ${r.unread.join(", ")}: the document didn't say it in a way Bike could read.` : null);
  };

  return (
    <div className="-mx-6 flex flex-col gap-1.5 border-b border-line">
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => (e.preventDefault(), setOver(false), void read(e.dataTransfer.files[0]))}
        className={cn("flex w-full cursor-pointer items-center gap-3 px-6 py-3 text-left", over ? "bg-primary-light" : "bg-white hover:bg-page")}
      >
        <span className="inline-flex shrink-0 text-icon">{reading ? <Loader size={18} strokeWidth={1.8} className="animate-spin" /> : <Upload size={18} strokeWidth={1.8} />}</span>
        <span className="flex flex-col leading-[1.4]">
          <span className="text-[14.5px] font-medium text-ink">{reading ? `Reading ${reading}…` : `Drop the ${what}`}</span>
          <span className="text-[14px] text-muted">An AI step fills the fields below. You check them before creating.</span>
        </span>
      </button>
      <input ref={input} type="file" accept=".pdf,.png,.jpg,.jpeg" hidden aria-label={`Drop the ${what}`} onChange={(e) => void read(e.target.files?.[0])} />
      {note ? <span className="px-6 pb-2 text-sm text-[#B45309]">{note}</span> : null}
    </div>
  );
}
