import { Filter, Hourglass } from "lucide-react";
import { Pill, stepTone } from "@/components/chips";
import { cn } from "@/lib/utils";
import type { PictureFlow, PictureStep } from "@/server/kernel/render-picture";
import { ChangedWords, MarkTag } from "./marks";

// A sheet's steps top to bottom (V1): numbered pills in their step colours joined by a line; under each, what brings
// a row there, its condition and who it waits on; the end steps together at the foot; the plain sentence below.

function StepRow({ step, last }: { step: PictureStep; last: boolean }) {
  const fresh = step.mark === "new";
  return (
    <li className="relative flex gap-2.5 pb-2.5" aria-label={step.name}>
      {last ? null : <span aria-hidden className="absolute top-7 bottom-0 left-[11px] border-l-[1.5px] border-[#CAD5E2]" />}
      <span className={cn("z-[1] inline-flex size-6 shrink-0 items-center justify-center rounded-full border-[1.5px] bg-white text-[11px] font-semibold", fresh ? "border-dashed border-[#18794E] text-[#18794E]" : "border-[#CAD5E2] text-muted")}>{step.n}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <Pill tone={stepTone(step)} className={cn("h-6 rounded-[6px] px-2 text-[14px] font-medium", fresh && "outline-[1.5px] outline-offset-2 outline-[#18794E] outline-dashed")}>{step.name}</Pill>
          {step.mark ? <MarkTag mark={step.mark} /> : null}
        </span>
        <Notes step={step} />
      </div>
    </li>
  );
}

function Notes({ step }: { step: PictureStep }) {
  if (!step.brings.length && !step.only && !step.waitsOn) return null;
  return (
    <span className="flex flex-col gap-0.5 text-[13.5px] leading-[1.45] text-muted">
      {step.brings.map((b) => (
        <span key={b.text} className="flex flex-wrap items-center gap-1.5">
          {b.change ? <span><ChangedWords change={b.change} /></span> : <span>{b.text}</span>}
          {b.mark ? <MarkTag mark={b.mark} /> : null}
        </span>
      ))}
      {step.only || step.waitsOn ? (
        <span className="flex flex-wrap items-center gap-x-2">
          {step.only ? (
            <span className="inline-flex items-center gap-1">
              <Filter size={13} strokeWidth={1.8} />
              only <span className="font-medium text-nav">{step.only}</span>
            </span>
          ) : null}
          {step.waitsOn ? (
            <span className="inline-flex items-center gap-1">
              <Hourglass size={13} strokeWidth={1.8} />
              waits on <span className="font-medium text-nav">{step.waitsOn}</span>
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

export function StepsFlow({ flow, title }: { flow: PictureFlow; title: string }) {
  return (
    <section aria-label={title}>
      <h3 className="m-0 pt-3 pb-2.5 text-[15px] font-semibold text-ink">{title}</h3>
      <ol className="m-0 list-none p-0">
        {flow.steps.map((s, i) => (
          <StepRow key={s.id} step={s} last={i === flow.steps.length - 1} />
        ))}
      </ol>
      {flow.ends.length ? (
        <div className="ml-[34px] flex flex-wrap items-center gap-2 text-[13.5px] text-muted">
          then
          {flow.ends.map((e, i) => (
            <span key={e.id} className="inline-flex items-center gap-2">
              {i ? "or" : null}
              <Pill tone={stepTone(e)} className="h-6 rounded-[6px] px-2 text-[14px] font-medium">{e.name}</Pill>
              {e.mark ? <MarkTag mark={e.mark} /> : null}
            </span>
          ))}
        </div>
      ) : null}
      <p className="m-0 mt-2.5 text-[13.5px] leading-[1.5] text-muted">{flow.caption}</p>
    </section>
  );
}
