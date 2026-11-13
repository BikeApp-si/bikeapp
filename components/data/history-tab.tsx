"use client";

import { useEffect, useState } from "react";
import { Avatar } from "@/components/chips";
import { Button } from "@/components/buttons";
import { addRowNote, rowHistory } from "@/app/ws/[ws]/(app)/c/[cap]/actions";
import type { HistoryItem } from "@/server/kernel/history";
import type { Person } from "./types";

// A row's History (0.4, M22): a note box, then its notes and changes, newest first. Notes show with their writer and
// time; changes as one quiet line each. Read through the kernel as the person, who may see the row.

// stamp: changes whenever the row does (a move, an edit), so History reads again.
export function HistoryTab({ rowId, stamp, people }: { rowId: string; stamp: string; people: Map<string, Person> }) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = () => rowHistory(rowId).then((r) => (r.ok ? setItems(r.items) : setProblem(r.error)));
  useEffect(() => void load(), [rowId, stamp]); // eslint-disable-line react-hooks/exhaustive-deps

  async function post() {
    if (!text.trim() || busy) return;
    setBusy(true);
    const r = await addRowNote(rowId, text);
    setBusy(false);
    if (!r.ok) return setProblem(r.error);
    setText("");
    setProblem(null);
    await load();
  }

  const avatar = (i: HistoryItem, size: number) => {
    const p = i.whoId ? people.get(i.whoId) : undefined;
    return <Avatar name={i.who} tint={p?.tint ?? "#94A3B8"} size={size} />;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <textarea
          aria-label="Add a note"
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && (e.preventDefault(), void post())}
          placeholder="Add a note…"
          className="w-full resize-none rounded-[8px] border border-line px-3 py-2 text-[15px] outline-none placeholder:text-[#90A1B9] focus:border-primary"
        />
        {problem ? <span className="text-[13.5px] text-[#DC2626]">{problem}</span> : null}
        {text.trim() ? (
          <Button small kind="primary" className="self-end" onClick={() => void post()} disabled={busy}>
            Post
          </Button>
        ) : null}
      </div>
      <ol aria-label="History" className="flex flex-col gap-3">
        {(items ?? []).map((i, n) =>
          i.kind === "note" ? (
            <li key={n} className="flex gap-2.5">
              {avatar(i, 22)}
              <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-[8px] bg-page px-3 py-2">
                <span className="text-[13.5px] text-muted">
                  <span className="font-medium text-ink">{i.who}</span> · {i.when}
                </span>
                <span className="text-[15px] whitespace-pre-wrap text-ink">{i.text}</span>
              </div>
            </li>
          ) : (
            <li key={n} className="flex items-baseline gap-2.5 pl-1 text-[14px] text-nav">
              <span className="mt-1.5 size-1.5 shrink-0 self-start rounded-full bg-line" />
              <span className="min-w-0 flex-1">
                {i.text}
                <span className="text-muted">
                  {" "}
                  · {i.who} · {i.when}
                </span>
              </span>
            </li>
          ),
        )}
      </ol>
    </div>
  );
}
