import { Segmented } from "@/components/segmented";

// 8e, X1, 8h: All and Waiting on me, with counts; a link each, so the filter is in the address.
export function WaitingSwitch({ all, waiting, on, href }: { all: number; waiting: number; on: boolean; href: (waiting: boolean) => string }) {
  const count = (n: number, active: boolean) => <span className={active ? "text-ink" : "text-muted"}>{n}</span>;
  return (
    <div className="flex items-center gap-2.5">
      <Segmented
        items={[
          { label: <>All{count(all, !on)}</>, href: href(false), active: !on },
          { label: <>Waiting on me{count(waiting, on)}</>, href: href(true), active: on },
        ]}
      />
      <span className="text-[15px] text-muted">Rows waiting on you. The same list comes by email each morning.</span>
    </div>
  );
}
