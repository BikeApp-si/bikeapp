import type { TextSection } from "@/server/kernel/render-text";
import { cn } from "@/lib/utils";

// An app's plain text as the gallery shows it (G2): the same sections a plan and Customize read, headings in bold.
// "Coming soon" is left out: it's the same for every app. "Changed in Ontology › Company rules." only reads inside
// Bike, so the public page leaves it out too (outside).
export function TextSections({ sections, outside, className }: { sections: TextSection[]; outside?: boolean; className?: string }) {
  return (
    <div className={cn("leading-[1.75] text-nav", className)}>
      {sections
        .filter((s) => s.heading !== "Coming soon")
        .map((s) => (
          <div key={s.heading}>
            <div className="pt-3 font-semibold text-ink">{s.heading}</div>
            {s.lines
              .filter((l) => !(outside && l.startsWith("Changed in Ontology")))
              .map((l, i) => (
                <div key={i} className={s.muted ? "text-muted" : undefined}>
                  {l}
                </div>
              ))}
          </div>
        ))}
    </div>
  );
}
