import Link from "next/link";
import { TOP_BAR_BG } from "@/lib/chrome";
import { cn } from "@/lib/utils";

// The line across the top of every signed-in page: 56 px, meeting the sidebar's top line (T1). The page's icon and name
// on the left (the icon centred 20 px in, on the tables' check column; the name on their first column's line, 40 px
// in), its actions on the right.
// plain: a page with its own main heading (Home).
// parent: the page above this one, as a link before the name ("App sets / Sample office").
export function TopBar({ title, icon, plain, parent, children }: { title: string; icon: React.ReactNode; plain?: boolean; parent?: { label: string; href: string }; children?: React.ReactNode }) {
  const Title = plain ? "span" : "h1";
  return (
    <div className={cn("flex h-14 shrink-0 items-center gap-2 border-b border-line pr-4 pl-3", TOP_BAR_BG)}>
      <span className="mr-1 inline-flex shrink-0 text-icon">{icon}</span>
      {parent ? (
        <>
          <Link href={parent.href} className="shrink-0 text-[15px] text-muted hover:text-ink">
            {parent.label}
          </Link>
          <span className="shrink-0 text-[15px] text-[#90A1B9]">/</span>
        </>
      ) : null}
      <Title className="m-0 min-w-0 flex-1 truncate text-[15px] font-medium text-ink">{title}</Title>
      {children}
    </div>
  );
}
