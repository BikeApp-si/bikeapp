"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/buttons";
import { deleteAiKey, saveAiCap, saveAiKey } from "@/app/ws/[ws]/(app)/settings/actions";
import { LABEL, LAST_ROW, ROW } from "./rows";
import { cn } from "@/lib/utils";

// Settings › AI's key and cap (docs/design/o3/a-ai-tab.png, a2). Each change goes through the kernel; the page is
// drawn again after it.

export type KeyShown = { source: "settings" | "env" | null; last4: string | null; broken: boolean; works: string | null };

const input = "h-9 rounded-[6px] border border-line bg-white px-3 text-[15px] text-ink outline-none placeholder:text-[#90A1B9] focus:border-primary focus:shadow-[0_0_0_3px_#DCEEFF]";
const CAP_LINE = "When this month’s use reaches it, building and changing apps stops until the 1st. Everyday work never stops.";
const dollars = (n: number) => `$${n % 1 ? n.toFixed(2) : n}`;

export function AiSettings({ k, cap }: { k: KeyShown; cap: number | null }) {
  const router = useRouter();
  const [editingKey, setEditingKey] = useState(!k.source);
  const [key, setKey] = useState("");
  const [editingCap, setEditingCap] = useState(false);
  const [capText, setCapText] = useState(cap === null ? "" : String(cap));
  const [error, setError] = useState<{ on: "key" | "cap"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (on: "key" | "cap", fn: () => Promise<{ ok: boolean; error?: string }>, done: () => void) => {
    setBusy(true);
    setError(null);
    const r = await fn().catch(() => ({ ok: false, error: "That didn’t work. Try again." }));
    setBusy(false);
    if (!r.ok) return setError({ on, text: r.error ?? "That didn’t work. Try again." });
    done();
    router.refresh();
  };

  const keyLine = k.broken
    ? "The key set here can’t be read: SESSION_SECRET changed since it was saved. Add it again."
    : k.source === "settings"
      ? `Set here.${k.works ? ` ${k.works}` : ""}`
      : k.source === "env"
        ? `From .env.${k.works ? ` ${k.works}` : ""}`
        : null;

  return (
    <>
      <div className={LABEL}>AI</div>
      {editingKey ? (
        <div className={cn(ROW, "flex-col items-stretch gap-2")}>
          <span className="text-base">Anthropic key</span>
          <div className="flex gap-2">
            <input aria-label="Anthropic key" className={cn(input, "flex-1 font-mono")} placeholder="sk-ant-…" value={key} autoComplete="off" spellCheck={false} onChange={(e) => setKey(e.target.value)} />
            <Button kind="primary" disabled={busy || !key.trim()} onClick={() => void run("key", () => saveAiKey(key), () => (setKey(""), setEditingKey(false)))}>
              {busy ? "Checking…" : "Save"}
            </Button>
            {k.source ? (
              <Button disabled={busy} onClick={() => (setEditingKey(false), setKey(""), setError(null))}>
                Cancel
              </Button>
            ) : null}
          </div>
          {error?.on === "key" ? <span className="text-[14.5px] text-danger">{error.text}</span> : null}
          <span className="text-[14.5px] leading-normal text-muted">Your company’s own key, from console.anthropic.com. Bike checks it with Anthropic before saving it.</span>
        </div>
      ) : (
        <div className={ROW}>
          <div className="flex flex-1 flex-col gap-0.5">
            <span className="text-base">Anthropic key</span>
            {keyLine ? <span className={cn("text-[14.5px] leading-normal", k.broken ? "text-danger" : "text-muted")}>{keyLine}</span> : null}
            {error?.on === "key" ? <span className="text-[14.5px] text-danger">{error.text}</span> : null}
          </div>
          {k.last4 ? <span className="font-mono text-[14.5px]">sk-ant-…{k.last4}</span> : null}
          <Button disabled={busy} onClick={() => setEditingKey(true)}>
            Replace
          </Button>
          {k.source === "settings" || k.broken ? (
            <Button disabled={busy} onClick={() => void run("key", deleteAiKey, () => undefined)}>
              Remove
            </Button>
          ) : null}
        </div>
      )}
      <div className={LAST_ROW}>
        <div className="flex flex-1 flex-col gap-0.5">
          <span className="text-base">Monthly cap</span>
          <span className="text-[14.5px] leading-normal text-muted">{CAP_LINE}</span>
          {error?.on === "cap" ? <span className="text-[14.5px] text-danger">{error.text}</span> : null}
        </div>
        {editingCap ? (
          <>
            <span className="text-base">$</span>
            <input aria-label="Monthly cap in dollars" inputMode="decimal" className={cn(input, "w-24 text-right")} value={capText} onChange={(e) => setCapText(e.target.value)} />
            <span className="text-base">a month</span>
            <Button kind="primary" disabled={busy} onClick={() => void run("cap", () => saveAiCap(capText.trim() ? Number(capText.replace(/[$,\s]/g, "")) : null), () => setEditingCap(false))}>
              Save
            </Button>
          </>
        ) : (
          <>
            <span className={cn("text-base", cap === null && "text-muted")}>{cap === null ? "None" : `${dollars(cap)} a month`}</span>
            <Button disabled={busy} onClick={() => setEditingCap(true)}>
              {cap === null ? "Set a cap" : "Change"}
            </Button>
          </>
        )}
      </div>
    </>
  );
}
