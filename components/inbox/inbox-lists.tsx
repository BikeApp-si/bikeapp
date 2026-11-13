import Link from "next/link";
import { ChevronRight, Zap } from "lucide-react";
import type { ReactNode } from "react";

// The Inbox's three lists (M31, m31-a to m31-e). Every item opens its row in its capability.

export type CapLook = { name: string; icon: ReactNode };
export type ToDoView = { key: string; href: string; capabilityId: string; title: string; label: string | null; line: string; dueToday: boolean };
export type WaitView = { key: string; href: string; capabilityId: string; title: string; on: string; label: string | null; line: string; since: string };
export type UpdateView = { key: string; href: string; capabilityId: string; title: string; who: string; byRule: boolean; text: string; when: string; isNew: boolean };

const Box = ({ children }: { children: ReactNode }) => <div className="overflow-hidden rounded-[10px] border border-line bg-white">{children}</div>;
const Empty = ({ children }: { children: ReactNode }) => <p className="m-0 px-1 pt-2 text-[14.5px] text-muted">{children}</p>;
const rowClass = (i: number) => `flex items-center gap-3 px-4 hover:bg-[#F6F8FB] ${i ? "border-t border-line" : ""}`;
const Chevron = () => <ChevronRight size={16} strokeWidth={1.8} className="shrink-0 text-icon" />;
const Avatar = ({ children }: { children: ReactNode }) => (
  <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-line text-[13px] font-medium text-ink">{children}</span>
);
// The row's capability icon, its title and "· Capability".
const RowName = ({ cap, title }: { cap: CapLook | undefined; title: string }) => (
  <span className="flex min-w-0 items-center gap-1.5 text-[14.5px]">
    <span className="inline-flex shrink-0">{cap?.icon}</span>
    <span className="truncate font-medium text-ink">{title}</span>
    <span className="shrink-0 text-muted">· {cap?.name}</span>
  </span>
);

// To do, grouped by capability in the sidebar's order.
export function ToDoList({ items, caps }: { items: ToDoView[]; caps: Map<string, CapLook> }) {
  if (!items.length) return <Empty>Nothing waits on you.</Empty>;
  const groups = [...caps.keys()].map((id) => [id, items.filter((i) => i.capabilityId === id)] as const).filter(([, list]) => list.length);
  return groups.map(([id, list]) => (
    <section key={id} aria-label={caps.get(id)?.name} className="flex flex-col gap-2">
      <h2 className="m-0 mt-2.5 flex items-center gap-2 px-1 text-[12.5px] font-medium text-muted">
        <span className="inline-flex">{caps.get(id)?.icon}</span>
        {caps.get(id)?.name}
      </h2>
      <Box>
        {list.map((t, i) => (
          <Link key={t.key} href={t.href} className={`${rowClass(i)} min-h-14 py-2`}>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-2 text-[14.5px]">
                <span className="font-medium text-ink">{t.title}</span>
                {t.label ? <span className="text-ink">· {t.label}</span> : null}
                {t.dueToday ? <span className="inline-flex h-[18px] items-center rounded-[4px] bg-[#FEF3C7] px-1.5 text-[12px] font-medium text-[#92400E]">Due today</span> : null}
              </span>
              <span className="truncate text-[13px] text-muted">{t.line}</span>
            </span>
            <Chevron />
          </Link>
        ))}
      </Box>
    </section>
  ));
}

export function WaitingList({ items, caps }: { items: WaitView[]; caps: Map<string, CapLook> }) {
  if (!items.length) return <Empty>Nothing you sent waits on anyone.</Empty>;
  return (
    <Box>
      {items.map((w, i) => (
        <Link key={w.key} href={w.href} className={`${rowClass(i)} min-h-[60px] py-2.5`}>
          <Avatar>{w.on.charAt(0)}</Avatar>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <RowName cap={caps.get(w.capabilityId)} title={w.title} />
            <span className="truncate text-[13.5px] text-nav">
              Waits on <span className="font-medium text-ink">{w.on}</span>
              {w.label ? ` · ${w.label}` : ""}
              {w.line ? <span className="text-muted"> · {w.line}</span> : null}
            </span>
          </span>
          <span className="shrink-0 text-[13px] text-muted">Since {w.since}</span>
          <Chevron />
        </Link>
      ))}
    </Box>
  );
}

export function UpdatesList({ items, caps }: { items: UpdateView[]; caps: Map<string, CapLook> }) {
  if (!items.length) return <Empty>Nothing has changed on your rows.</Empty>;
  return (
    <Box>
      {items.map((u, i) => (
        <Link key={u.key} href={u.href} className={`${rowClass(i)} min-h-[60px] py-2.5`}>
          <span className="w-2 shrink-0">{u.isNew ? <span aria-label="New" className="block size-2 rounded-full bg-primary" /> : null}</span>
          <Avatar>{u.byRule ? <Zap size={14} strokeWidth={1.8} /> : u.who.charAt(0)}</Avatar>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <RowName cap={caps.get(u.capabilityId)} title={u.title} />
            <span className={`truncate text-[13.5px] ${u.isNew ? "text-ink" : "text-nav"}`}>
              <span className="font-medium">{u.who}</span> · {u.text}
            </span>
          </span>
          <span className="shrink-0 text-[13px] text-muted">{u.when}</span>
        </Link>
      ))}
    </Box>
  );
}
