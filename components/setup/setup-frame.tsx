import { Check } from "lucide-react";
import { BikeMark } from "@/components/logo";
import { cn } from "@/lib/utils";

const STEPS = ["Address", "Organization", "Team"] as const;

// The setup header (Bike, or the company and its address once it exists; then the three steps) and the
// page below a straight line, as on 2a–2f. Step 4 is 2f: every step done.
export function SetupFrame({ step, company, children }: { step: 1 | 2 | 3 | 4; company?: { name: string; address: string }; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-white text-ink">
      <header className="flex h-14 border-b border-line flex-wrap items-center justify-between gap-4 px-5">
        <span className="inline-flex items-center gap-2 text-base font-medium">
          <BikeMark size={22} />
          {company ? (
            <>
              {company.name}
              <span className="text-[15px] font-normal text-muted">· {company.address}</span>
            </>
          ) : (
            "Bike"
          )}
        </span>
        <div className="flex items-center gap-2">
          {STEPS.map((name, i) => {
            const n = i + 1;
            const state = n < step ? "done" : n === step ? "current" : "next";
            return (
              <span key={name} className="contents">
                {i > 0 ? <span className="h-px w-6 bg-line" /> : null}
                <span className={cn("inline-flex items-center gap-1.5 text-[15px]", state === "next" ? "text-muted" : "font-medium text-ink")}>
                  <span
                    className={cn(
                      "inline-flex size-5 items-center justify-center rounded-full text-[13.5px]",
                      state === "next" ? "border border-line bg-white text-muted" : state === "current" ? "bg-primary text-white" : "bg-primary-deep text-white",
                    )}
                  >
                    {state === "done" ? <Check size={12} strokeWidth={2} /> : n}
                  </span>
                  {name}
                </span>
              </span>
            );
          })}
        </div>
        <span className="flex w-40 justify-end" />
      </header>
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  );
}
