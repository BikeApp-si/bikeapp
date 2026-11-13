import Link from "next/link";
import { OUTLINED } from "@/components/buttons";
import { cn } from "@/lib/utils";

// Settings' Company | Instance | AI, in the open Bike only (docs/design/o2/c-instance.png). The hosted service runs the
// servers itself, so it has no Instance page and no tabs. Drawn as the Ontology's outlined buttons (decided Nov 13,
// docs/design/o6/settings-tabs.png): the one you're on in ink with a darker line, the others muted.
const TABS = [
  { key: "company", label: "Company", href: "/settings" },
  { key: "instance", label: "Instance", href: "/settings/instance" },
  { key: "ai", label: "AI", href: "/settings/ai" },
] as const;

export function SettingsTabs({ on }: { on: (typeof TABS)[number]["key"] }) {
  return (
    <div role="tablist" className="flex shrink-0 items-center gap-2">
      {TABS.map((t) => (
        <Link key={t.key} href={t.href} role="tab" aria-selected={on === t.key} className={cn(OUTLINED, on === t.key ? "border-muted text-ink" : "text-muted hover:text-ink")}>
          {t.label}
        </Link>
      ))}
    </div>
  );
}
