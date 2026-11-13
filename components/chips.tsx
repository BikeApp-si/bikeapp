import { cn } from "@/lib/utils";

export type Tone = "grey" | "blue" | "green" | "orange" | "yellow" | "violet" | "done";

// Pill colours, from the screens (6a, 8a, 8d).
const TONES: Record<Tone, string> = {
  grey: "bg-[#E2E8F0] text-[#62748E]",
  blue: "bg-[#E3EDFD] text-primary-text",
  green: "bg-[#DDF6E2] text-[#18794E]",
  orange: "bg-[#FDEBDD] text-[#B85C14]",
  yellow: "bg-[#FEF3C7] text-[#92400E]",
  violet: "bg-primary-light text-primary-hover",
  done: "bg-fill text-nav",
};

export function Pill({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return <span className={cn("inline-flex h-5 items-center whitespace-nowrap rounded-[4px] px-1.5 text-[15px]", TONES[tone], className)}>{children}</span>;
}

// G3: a set that's new carries this beside its name, in the gallery and its add flow.
export function BetaTag() {
  return <Pill tone="orange">Beta</Pill>;
}

// A step's tone: its own, else grey for the start, "done" for an end, violet for the rest.
export function stepTone(step: { tone?: Tone; start?: boolean; end?: string } | undefined): Tone {
  if (!step) return "grey";
  return step.tone ?? (step.start ? "grey" : step.end ? "done" : "violet");
}

export function Avatar({ name, tint, size = 14, className }: { name: string; tint: string; size?: number; className?: string }) {
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full text-white", className)}
      style={{ width: size, height: size, background: tint, fontSize: Math.max(9, Math.round(size * 0.42)) }}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

// "K Krishna" on a light fill, as in tables and panels.
export function PersonChip({ name, tint, large }: { name: string; tint: string; large?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-[4px] bg-fill text-ink", large ? "h-[26px] gap-1.5 pr-2 pl-1" : "h-5 pr-1.5 pl-0.5")}>
      <Avatar name={name} tint={tint} size={large ? 18 : 14} />
      {name}
    </span>
  );
}
