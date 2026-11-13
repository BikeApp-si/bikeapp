"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { ChevronDown, GraduationCap, X, CircleHelp } from "lucide-react";
import { Button } from "@/components/buttons";
import { cn } from "@/lib/utils";
import { useModel } from "@/components/no-model";
import { tutorialOf, tutorialSeen } from "@/app/ws/[ws]/(app)/c/[cap]/actions";
import type { Tutorial, TutorialCard as Card } from "@/server/kernel/tutorial";

// A capability's tutorial (0.4, M24): the "Tutorial" link in its header and the card above its table share one
// tutorial, read (or written once for this person's access) through the kernel, and one panel. The card shows on a
// new capability and after a change to the reader's own steps, until "Got it". It sits above the table, compact, so a
// sheet with many rows still shows it first.

type State = { tutorial: Tutorial | null; card: Card; error: string | null; loading: boolean };
type Ctx = State & { capName: string; open: () => void; seen: () => Promise<void>; panelOpen: boolean };

const TutorialContext = createContext<Ctx | null>(null);

export function TutorialProvider({ capId, capName, introduce: asked, children }: { capId: string; capName: string; introduce: boolean; children: React.ReactNode }) {
  // With no model (O3) there is no tutorial: no card, no Help button (Wade, Nov 12).
  const model = useModel();
  const introduce = asked && !model.none;
  // Only a capability whose card may show reads it when the page opens; others when the link is clicked.
  const [state, setState] = useState<State>({ tutorial: null, card: null, error: null, loading: introduce });
  const [panel, setPanel] = useState(false);

  const fetchIt = useCallback(
    () =>
      tutorialOf(capId)
        .then((r) =>
          setState(r.ok ? { tutorial: r.state.tutorial, card: r.state.card, error: null, loading: false } : { tutorial: null, card: null, error: r.error, loading: false }),
        )
        // A failed request (the network, the server) reads like any other failure: no card, a plain line in the panel.
        .catch(() => setState({ tutorial: null, card: null, error: `Bike couldn't write ${capName}'s help just now. Try again in a moment.`, loading: false })),
    [capId, capName],
  );

  useEffect(() => {
    if (introduce) void fetchIt();
  }, [introduce, fetchIt]);

  const open = () => {
    setPanel(true);
    if (state.tutorial || state.loading) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    void fetchIt();
  };
  const seen = async () => {
    setState((s) => ({ ...s, card: null }));
    await tutorialSeen(capId);
  };

  return (
    <TutorialContext.Provider value={{ ...state, capName, open, seen, panelOpen: panel }}>
      {children}
      {panel ? <TutorialPanel onClose={() => setPanel(false)} /> : null}
    </TutorialContext.Provider>
  );
}

const useTutorial = () => useContext(TutorialContext)!;

// The Help button in the top bar, beside the ⋯ menu.
export function TutorialLink() {
  const t = useTutorial();
  const model = useModel();
  if (model.none) return null;
  return (
    <button type="button" aria-label="Help" onClick={t.open} className={cn("inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-icon outline-none hover:bg-active-nav focus-visible:ring-3 focus-visible:ring-focus", t.panelOpen && "bg-active-nav")}>
      <CircleHelp size={16} strokeWidth={1.8} />
    </button>
  );
}

// Above the table: a title line, the first three steps side by side, Read all and Got it. Folds to one line.
export function TutorialCard({ capId }: { capId: string }) {
  const t = useTutorial();
  const key = `bike:tutorial-folded:${capId}`;
  // Read once on the browser; the card itself only draws there, once its tutorial has arrived.
  const [folded, setFolded] = useState(() => typeof window !== "undefined" && window.localStorage.getItem(key) === "1");
  if (!t.card || !t.tutorial) return null;
  const fold = (on: boolean) => (setFolded(on), on ? window.localStorage.setItem(key, "1") : window.localStorage.removeItem(key));
  const title = t.card.kind === "changed" ? `${t.capName} has changed` : `Help: ${t.capName}`;
  return (
    <section aria-label={title} className="rounded-[10px] border border-primary-border bg-white px-4 py-3">
      <div className="flex items-center gap-2">
        <GraduationCap size={16} strokeWidth={1.8} className="shrink-0 text-primary-text" />
        <h2 className="m-0 min-w-0 flex-1 truncate text-[15px] font-semibold">
          {title}
          {t.card.kind === "changed" && t.card.change ? <span className="font-normal text-muted"> · {t.card.change}</span> : null}
        </h2>
        <button type="button" onClick={t.open} className="cursor-pointer text-[14.5px] text-primary-text hover:underline">
          Read all
        </button>
        <Button small onClick={() => void t.seen()}>
          Got it
        </Button>
        <button type="button" aria-label={folded ? "Show" : "Fold"} aria-expanded={!folded} onClick={() => fold(!folded)} className="inline-flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-muted hover:bg-page">
          <ChevronDown size={15} strokeWidth={1.8} className={cn("transition-transform", folded && "-rotate-90")} />
        </button>
      </div>
      {folded ? null : (
        <ol className="mt-2.5 grid grid-cols-3 gap-4">
          {t.tutorial.steps.slice(0, 3).map((s, i) => (
            <li key={s.title} className="flex min-w-0 gap-2">
              <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary-light text-[12px] font-semibold text-primary-text">{i + 1}</span>
              <span className="flex min-w-0 flex-col">
                <span className="flex items-center gap-1.5 text-[14.5px] font-medium text-ink">
                  <span className="truncate">{s.title}</span>
                  {t.card!.isNew.includes(s.title) ? <span className="shrink-0 rounded-[4px] bg-primary-light px-1.5 text-[12px] font-medium text-primary-text">New</span> : null}
                </span>
                <span className="line-clamp-2 text-[13.5px] leading-[1.45] text-muted">{s.text}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// The whole tutorial, in a panel from the right like a record's.
function TutorialPanel({ onClose }: { onClose: () => void }) {
  const t = useTutorial();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const isNew = (title: string) => !!t.card?.isNew.includes(title);
  return (
    <aside role="dialog" aria-label={`${t.capName} · Help`} className="absolute inset-y-0 right-0 z-20 flex w-[560px] flex-col border-l border-line bg-white">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line pr-3 pl-6">
        <GraduationCap size={18} strokeWidth={1.8} className="text-primary-text" />
        <h2 className="m-0 flex-1 text-[15px] font-medium">{t.capName} · Help</h2>
        <button type="button" aria-label="Close" onClick={onClose} className="inline-flex size-8 cursor-pointer items-center justify-center rounded-[6px] text-icon hover:bg-page">
          <X size={16} strokeWidth={1.8} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
        {t.loading && !t.tutorial ? <p className="m-0 text-[15px] text-muted">Writing {t.capName}&apos;s help…</p> : null}
        {t.error ? <p className="m-0 text-[15px] text-[#DC2626]">{t.error}</p> : null}
        {t.tutorial ? (
          <>
            <p className="m-0 text-base leading-[1.6] text-ink">{t.tutorial.purpose}</p>
            <ol className="m-0 flex list-none flex-col gap-4 p-0">
              {t.tutorial.steps.map((s, i) => (
                <li key={s.title} className="flex gap-3">
                  <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-light text-[13px] font-semibold text-primary-text">{i + 1}</span>
                  <span className="flex flex-col gap-1">
                    <span className="flex items-center gap-1.5 text-[15px] font-semibold text-ink">
                      {s.title}
                      {isNew(s.title) ? <span className="rounded-[4px] bg-primary-light px-1.5 text-[12px] font-medium text-primary-text">New</span> : null}
                    </span>
                    <span className="text-[15px] leading-[1.55] text-nav">{s.text}</span>
                  </span>
                </li>
              ))}
            </ol>
            {t.tutorial.waits.length ? <List title="Waits on" items={t.tutorial.waits} /> : null}
            {t.tutorial.cannot.length ? <List title="You can't" items={t.tutorial.cannot} /> : null}
          </>
        ) : null}
      </div>
    </aside>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="m-0 text-[13.5px] font-medium text-muted">{title}</h3>
      <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[15px] leading-[1.55] text-nav">
        {items.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </section>
  );
}
