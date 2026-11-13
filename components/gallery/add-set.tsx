"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, Check, CircleCheck, Plus, X } from "lucide-react";
import { addGallerySet, previewGallerySet } from "@/app/ws/[ws]/(app)/gallery/actions";
import { Button } from "@/components/buttons";
import { Avatar, BetaTag } from "@/components/chips";
import { Picker } from "@/components/picker";
import type { SetPreview } from "@/server/kernel/gallery/add";
import type { AddPage } from "@/server/gallery/page";
import { TextSections } from "./text-sections";

// G2 (g2-d, g2-e, g2-f, g2-g, g2-h): adding an app set in three steps: the apps, who fills each role, then the plan
// as the kernel checked it, with Add these apps. Nothing is saved before Add; a refusal shows the kernel's words.

type Props = { setKey: string; name: string; description: string; beta?: boolean; page: AddPage; icons: Record<string, React.ReactNode> };
type Added = { apps: { key: string; id: string; name: string }[] };

const STEPS = ["Apps", "People", "Plan"];

export function AddSet({ setKey, name, description, beta, page, icons }: Props) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [apps, setApps] = useState(page.apps.map((a) => a.key));
  const [slots, setSlots] = useState<Record<string, string[]>>(page.suggested);
  const [preview, setPreview] = useState<SetPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<Added | null>(null);

  // The roles the picked apps use, and those of the company rules that come with them (all their apps picked).
  const used = new Set([
    ...page.apps.filter((a) => apps.includes(a.key)).flatMap((a) => a.slots),
    ...page.rules.filter((r) => r.apps.every((a) => apps.includes(a))).flatMap((r) => r.slots),
  ]);
  const shownSlots = page.slots.filter((s) => used.has(s.key));
  const choice = () => ({ apps, slots: Object.fromEntries(shownSlots.map((s) => [s.key, slots[s.key] ?? []])) });
  const nameOf = (key: string) => page.apps.find((a) => a.key === key)?.name ?? key;

  async function toPlan() {
    setBusy(true);
    const r = await previewGallerySet(setKey, choice());
    setBusy(false);
    if (!r.ok) return setProblem(r.error);
    setProblem(null);
    setPreview(r.preview);
    setStep(2);
  }

  async function add() {
    setBusy(true);
    const r = await addGallerySet(setKey, choice());
    setBusy(false);
    if (!r.ok) return setProblem(r.error);
    setAdded(r.added);
    router.refresh(); // the sidebar lists the new apps
  }

  if (added) return <Done name={name} added={added} page={page} icons={icons} roles={shownSlots.length} rules={page.rules.filter((r) => r.apps.every((a) => apps.includes(a))).length} />;

  const footer = "mt-6 flex items-center justify-between border-t border-line pt-4";
  const shownProblems = problem ? [problem] : (preview?.problems ?? []);
  return (
    <div className="mx-auto w-full max-w-[760px] px-6 pt-10 pb-10">
      <div className="flex gap-1">{page.apps.map((a) => <span key={a.key}>{icons[a.key]}</span>)}</div>
      <h2 className="mt-3.5 mb-0 flex items-center gap-2.5 text-[26px] font-semibold tracking-[-0.015em]">
        {name}
        {beta ? <BetaTag /> : null}
      </h2>
      <p className="mt-1 mb-0 text-[15.5px] leading-[1.55] text-muted">{description}</p>

      <ol aria-label="Steps" className="mt-6 mb-0 flex list-none items-center gap-2.5 border-b border-line p-0 pb-4 text-[15px]">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-2.5" aria-current={i === step ? "step" : undefined}>
            <span className={`flex items-center gap-2 ${i === step ? "font-semibold text-ink" : "text-muted"}`}>
              {i < step ? (
                <span className="inline-flex size-5 items-center justify-center rounded-full bg-primary">
                  <Check size={12} color="#fff" strokeWidth={2.6} />
                </span>
              ) : (
                <span className={`inline-flex size-5 items-center justify-center rounded-full border text-[12px] font-semibold ${i === step ? "border-primary text-primary-text" : "border-line text-muted"}`}>{i + 1}</span>
              )}
              {s}
            </span>
            {i < STEPS.length - 1 ? <span className="h-px w-7 bg-line" /> : null}
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <>
          <div>
            {page.apps.map((a) => {
              const on = apps.includes(a.key);
              return (
                <label key={a.key} className="flex cursor-pointer items-start gap-3.5 border-b border-line py-3.5">
                  <input
                    type="checkbox"
                    className="mt-1.5 size-[18px] accent-primary"
                    checked={on}
                    onChange={() => setApps((xs) => (on ? xs.filter((x) => x !== a.key) : page.apps.map((p) => p.key).filter((k) => k === a.key || xs.includes(k))))}
                  />
                  {icons[a.key]}
                  <span className="flex-1">
                    <span className="block text-base font-semibold">{a.name}</span>
                    <span className="block text-[15px] text-muted">{a.description}</span>
                  </span>
                  {a.needs.length ? <span className="pt-1 text-sm text-muted">Needs {a.needs.map(nameOf).join(" and ")}</span> : null}
                </label>
              );
            })}
          </div>
          <div className={footer}>
            <span className="text-[15px] text-muted">
              {apps.length} of {page.apps.length} apps
            </span>
            <span className="flex gap-2">
              <Link href="/gallery" className="inline-flex h-9 items-center rounded-[6px] border border-line bg-white px-3.5 text-[15px] font-medium text-ink hover:bg-page">
                Cancel
              </Link>
              <Button kind="primary" disabled={!apps.length} onClick={() => (shownSlots.length ? setStep(1) : void toPlan())}>
                Next: {shownSlots.length ? "People" : "Plan"} <ArrowRight size={15} />
              </Button>
            </span>
          </div>
        </>
      ) : null}

      {step === 1 ? (
        <>
          {shownSlots.map((s) => (
            <SlotRow
              key={s.key}
              slot={s}
              people={page.people}
              picked={slots[s.key] ?? []}
              suggested={(page.suggested[s.key] ?? []).length > 0 && sameSet(page.suggested[s.key]!, slots[s.key] ?? [])}
              onChange={(ids) => setSlots((x) => ({ ...x, [s.key]: ids }))}
            />
          ))}
          {problem ? <Problems items={[problem]} /> : null}
          <div className={footer}>
            <Button onClick={() => setStep(0)}>Back</Button>
            <Button kind="primary" disabled={busy} onClick={() => void toPlan()}>
              Next: Plan <ArrowRight size={15} />
            </Button>
          </div>
        </>
      ) : null}

      {step === 2 && preview ? (
        <>
          {shownProblems.length ? <Problems items={shownProblems} /> : null}
          {page.apps
            .filter((a) => apps.includes(a.key))
            .map((a) => {
              const sections = preview.plan?.find((p) => p.key === a.key)?.sections;
              return (
              <section key={a.key} aria-label={a.name} className="mt-5 rounded-[10px] border border-line">
                <div className={`flex items-center gap-2.5 px-4 py-3 ${sections ? "border-b border-line" : ""}`}>
                  {icons[a.key]}
                  <span className="flex-1 text-lg font-semibold">{a.name}</span>
                  <span className="inline-flex h-[22px] items-center rounded-[6px] bg-fill px-2 text-[13.5px] font-medium text-icon">Not added yet</span>
                </div>
                {sections ? <TextSections className="px-4 pb-3.5 text-[15.5px]" sections={sections} /> : null}
              </section>
              );
            })}
          {preview.alsoChanges?.length ? (
            <div className="mt-5 text-[15.5px] leading-[1.75]">
              <div className="font-semibold">Also changes</div>
              {preview.alsoChanges.map((l) => (
                <div key={l} className="text-nav">
                  {l}
                </div>
              ))}
            </div>
          ) : null}
          <div className={`${footer} sticky bottom-0 bg-white pb-4`}>
            <Button onClick={() => (setProblem(null), setStep(shownSlots.length ? 1 : 0))}>Back</Button>
            <span className="flex items-center gap-3.5">
              <span className="text-[14.5px] text-muted">{apps.length === 1 ? "1 app" : `${apps.length} apps`} · no AI used</span>
              <Button kind="primary" disabled={busy || shownProblems.length > 0} onClick={() => void add()}>
                Add these apps
              </Button>
            </span>
          </div>
        </>
      ) : null}
    </div>
  );
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

function Problems({ items }: { items: string[] }) {
  return (
    <div role="alert" className="mt-4 flex flex-col gap-1 rounded-[8px] bg-[#FEF2F2] px-3.5 py-3 text-[15px] leading-[1.5] text-[#C10007]">
      {items.map((p) => (
        <div key={p}>{p}</div>
      ))}
    </div>
  );
}

type Slot = AddPage["slots"][number];
type Person = AddPage["people"][number];

function SlotRow({ slot, people, picked, suggested, onChange }: { slot: Slot; people: Person[]; picked: string[]; suggested: boolean; onChange: (ids: string[]) => void }) {
  const byId = new Map(people.map((p) => [p.id, p]));
  const option = (p: Person) => ({ id: p.id, label: p.name, node: <span className="flex items-center gap-2"><Avatar name={p.name} tint={p.tint} size={20} />{p.name}</span> });
  return (
    <div className="flex gap-6 border-b border-line py-4" role="group" aria-label={slot.name}>
      <div className="w-[220px] shrink-0">
        <div className="text-base font-semibold">{slot.name}</div>
        <div className="text-[14.5px] leading-[1.5] text-muted">{[slot.one ? "One person." : null, slot.does].filter(Boolean).join(" ")}</div>
      </div>
      <div className="flex flex-1 flex-col gap-1.5">
        {slot.one ? (
          <Picker label={slot.name} placeholder="Pick someone" value={picked[0] ?? null} options={people.map(option)} onChange={(id) => onChange(id ? [id] : [])} />
        ) : (
          <span className="flex flex-wrap items-center gap-1.5">
            {picked.map((id) => {
              const p = byId.get(id);
              return p ? (
                <span key={id} className="inline-flex h-[30px] items-center gap-1.5 rounded-full border border-line pr-1.5 pl-1 text-[15px]">
                  <Avatar name={p.name} tint={p.tint} size={22} />
                  {p.name}
                  <button type="button" aria-label={`Remove ${p.name}`} className="inline-flex cursor-pointer text-muted hover:text-ink" onClick={() => onChange(picked.filter((x) => x !== id))}>
                    <X size={13} />
                  </button>
                </span>
              ) : null;
            })}
            <Picker
              label={`Add to ${slot.name}`}
              value={null}
              options={people.filter((p) => !picked.includes(p.id)).map(option)}
              onChange={(id) => id && onChange([...picked, id])}
              trigger={
                <button type="button" aria-label={`Add to ${slot.name}`} className="inline-flex h-[30px] cursor-pointer items-center gap-1 px-2 text-[15px] text-muted hover:text-ink">
                  <Plus size={14} />
                  Add
                </button>
              }
            />
          </span>
        )}
        {suggested ? <span className="text-sm text-muted">Suggested from job titles</span> : null}
      </div>
    </div>
  );
}

function Done({ name, added, page, icons, roles, rules }: { name: string; added: Added; page: AddPage; icons: Record<string, React.ReactNode>; roles: number; rules: number }) {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const parts = [n(added.apps.length, "app", "apps"), ...(roles ? [n(roles, "role", "roles")] : []), ...(rules ? [n(rules, "company rule", "company rules")] : [])];
  const said = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return (
    <div className="mx-auto w-full max-w-[760px] px-6 pt-10 pb-10">
      <div className="flex items-center gap-2.5">
        <CircleCheck size={24} color="#059669" strokeWidth={2} />
        <h2 className="m-0 text-[26px] font-semibold tracking-[-0.015em]">{name} is added</h2>
      </div>
      <p className="mt-1.5 mb-0 text-[15.5px] text-muted">{said}, added by you just now. They’re yours: change any of them in Customize.</p>
      <div className="mt-5 border-t border-line">
        {added.apps.map((a) => (
          <div key={a.id} className="flex items-center gap-3 border-b border-line py-3.5">
            {icons[a.key]}
            <span className="flex-1">
              <span className="block text-base font-semibold">{a.name}</span>
              <span className="block text-[15px] text-muted">{page.apps.find((p) => p.key === a.key)?.description}</span>
            </span>
            <Link href={`/c/${a.id}`} className="inline-flex h-9 items-center rounded-[6px] border border-line bg-white px-3.5 text-[15px] font-medium text-ink hover:bg-page">
              Open
            </Link>
          </div>
        ))}
      </div>
      <Link href="/audit" className="mt-4.5 inline-block text-[15px] font-medium text-primary-text hover:text-primary-hover">
        See it in the Audit log →
      </Link>
    </div>
  );
}
