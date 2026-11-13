import * as lucide from "lucide-react";
import { icons, LayoutGrid, type LucideIcon, type LucideProps } from "lucide-react";

// A capability's lucide icon by its stored name ("file-pen-line", or an older name lucide keeps as an alias,
// such as "file-signature"); layout-grid when the name is unknown. Rendered on the server, so the icon set
// never reaches the browser.
// A capability's own colour (0.4, M23) is passed as `color`; every other icon keeps the text colour.
export function CapIcon({ name, ...props }: { name: string } & LucideProps) {
  const pascal = name.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());
  const Icon = icons[pascal as keyof typeof icons] ?? (lucide as unknown as Record<string, LucideIcon | undefined>)[pascal] ?? LayoutGrid;
  return <Icon {...props} />;
}

// 18 px icon in a 32 px white square with a 1 px border and 8 px radius (developer notes §2).
// The box stays white; only the icon takes the capability's colour (no coloured tiles).
export function CapIconBox({ name, color }: { name: string; color?: string }) {
  return (
    <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-[8px] border border-line bg-white text-ink">
      <CapIcon name={name} size={18} strokeWidth={2} color={color} />
    </span>
  );
}
