import { ArrowLeft, ArrowRight, BookOpen, Clock, Eye, History, LayoutGrid, Network, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { CapIcon, CapIconBox } from "@/components/cap-icon";
import { capColor } from "@/lib/cap-colors";
import type { OntologyView } from "@/server/kernel/ontology";

// 4e's page body: how the company runs (prompt 6's paragraphs), every connection and each capability in a
// sentence (the kernel's breakdown), and what is worth a look.

const p = "m-0 text-[14.5px] leading-[1.7] text-[#1D293D]";

function Heading({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 pt-[18px] text-base font-semibold">
      {icon}
      {children}
    </div>
  );
}

function Chip({ name, icon, color }: { name: string; icon: string; color?: string }) {
  return (
    <span className="inline-flex h-[30px] items-center gap-1.5 rounded-[8px] border border-line bg-white px-2.5 text-[15px] font-medium whitespace-nowrap">
      <CapIcon name={icon} size={15} strokeWidth={1.8} color={capColor(color)} />
      {name}
    </span>
  );
}

// past: a version read only (m34-c), with the banner that says which and the way back.
export function OntologyBody({ view, line, past }: { view: OntologyView; line: string; past?: { banner: string } }) {
  const h = { size: 16, strokeWidth: 2 };
  return (
    <div className="min-h-0 flex-1 overflow-auto px-8">
      <div className="mx-auto flex max-w-[856px] flex-col gap-3 pt-7 pb-6">
        {past ? (
          <div className="flex items-center gap-3.5 rounded-[10px] border border-line bg-[#F8FAFC] px-4 py-3 text-[15px] text-[#1D293D]">
            <History size={15} strokeWidth={2} className="shrink-0 text-muted" />
            <span className="flex-1 leading-[1.5]">{past.banner}</span>
            <Link href="/ontology" className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-line bg-white px-3 font-medium whitespace-nowrap text-ink hover:bg-page">
              <ArrowLeft size={15} strokeWidth={2} />
              Back to current
            </Link>
          </div>
        ) : null}
        <div className="text-2xl font-semibold tracking-[-0.015em]">How {view.company} runs</div>
        <div className="text-[15px] text-muted">{line}</div>
        {view.intro ? <p className={p}>{view.intro}</p> : null}

        {view.paragraphs.length ? (
          <>
            <Heading icon={<BookOpen {...h} />}>How it all fits together</Heading>
            <div className="flex flex-col gap-3.5">
              {view.paragraphs.map((text, i) => (
                <p key={i} className={p}>
                  {text}
                </p>
              ))}
            </div>
          </>
        ) : null}

        {view.connections.length ? (
          <>
            <Heading icon={<Network {...h} />}>Every connection</Heading>
            <div className="rounded-[10px] border border-line bg-[#FAFBFC] px-4 py-2.5">
              {view.connections.map((c) => (
                <div key={`${c.from}>${c.to}`} className="flex items-center gap-2.5 py-[7px]">
                  <Chip name={c.from} icon={c.fromIcon} color={c.fromColor} />
                  <ArrowRight size={14} strokeWidth={2} className="shrink-0 text-[#90A1B9]" />
                  <Chip name={c.to} icon={c.toIcon} color={c.toColor} />
                  <span className="text-[15.5px] text-muted">{c.phrase}</span>
                </div>
              ))}
              <div className="pt-1.5 pb-0.5 text-sm text-[#90A1B9]">
                People feeds every app. Each connection starts a row in the next app when a row reaches a step, and both sides record it in the Audit log.
              </div>
            </div>
          </>
        ) : null}

        <Heading icon={<LayoutGrid {...h} />}>Each app in a sentence</Heading>
        <div className="-mt-3">
          {view.each.map((c) => (
            <div key={c.name} className="flex gap-3.5 border-b border-fill py-3.5">
              <CapIconBox name={c.icon} color={capColor(c.color)} />
              <div className="flex flex-1 flex-col gap-[3px]">
                <span className="text-[14.5px] font-semibold">{c.name}</span>
                <span className="text-base leading-[1.65] text-[#1D293D]">{c.sentence}</span>
                <span className="text-sm text-[#90A1B9]">{c.meta}</span>
              </div>
            </div>
          ))}
        </div>

        {view.worth.length ? (
          <>
            <Heading icon={<Eye {...h} />}>Worth a look</Heading>
            <div className="flex flex-col gap-1.5">
              {view.worth.map((w) => (
                <div key={w} className="flex gap-2.5 text-base leading-[1.6]">
                  <span className="inline-flex pt-[3px] text-[#B45309]">
                    <TriangleAlert size={16} strokeWidth={2} />
                  </span>
                  <span>{w}</span>
                </div>
              ))}
            </div>
          </>
        ) : null}

        <Heading icon={<Clock {...h} />}>Coming soon</Heading>
        <span className="text-base text-muted">Who decides what, from your approval rules</span>
      </div>
    </div>
  );
}
