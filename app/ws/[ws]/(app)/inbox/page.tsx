import { connection } from "next/server";
import { CapIcon } from "@/components/cap-icon";
import { SystemIcon } from "@/components/shell/system-icon";
import { TopBar } from "@/components/shell/top-bar";
import { Segmented } from "@/components/segmented";
import { ToDoList, UpdatesList, WaitingList, type CapLook } from "@/components/inbox/inbox-lists";
import { SeenUpdates } from "@/components/inbox/seen-updates";
import { capColor } from "@/lib/cap-colors";
import { dayIn, formatDay } from "@/lib/format";
import { asPage } from "@/server/auth/kernel-call";
import { currentWorkspace, requirePerson } from "@/server/auth/current";
import { capabilitiesFor } from "@/server/kernel/capabilities";
import { todayIn, workspaceFormats } from "@/server/kernel/context";
import { toDo, updatesFor, waitingOnOthers } from "@/server/kernel/inbox";

// The Inbox (0.5, M31; m31-a to m31-e): To do | Waiting on others | Updates, for everyone.
const TABS = { todo: "To do", waiting: "Waiting on others", updates: "Updates" } as const;
type Tab = keyof typeof TABS;
const rowHref = (i: { capabilityId: string; sheetId: string; rowId: string }) => `/c/${i.capabilityId}?sheet=${i.sheetId}&row=${i.rowId}`;

export default async function InboxPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ tab?: string }> }) {
  await connection();
  const wsParam = (await params).ws;
  const ws = await currentWorkspace(wsParam);
  await requirePerson(ws);
  const asked = (await searchParams).tab;
  const tab: Tab = asked === "waiting" || asked === "updates" ? asked : "todo";
  const { caps, todos, waits, updates, formats } = await asPage(wsParam, async (tx, ctx) => ({
    caps: await capabilitiesFor(tx, ctx),
    todos: await toDo(tx, ctx),
    waits: await waitingOnOthers(tx, ctx),
    updates: await updatesFor(tx, ctx),
    formats: await workspaceFormats(tx),
  }));
  const looks = new Map<string, CapLook>(caps.map((c) => [c.id, { name: c.name, icon: <CapIcon name={c.icon} size={16} strokeWidth={1.8} color={capColor(c.color)} /> }]));
  const today = todayIn(ws.timeZone);
  const fresh = updates.filter((u) => u.isNew).length;
  const count = (n: number, label?: string) => (n ? <span className={label ? "font-normal text-primary" : "font-normal text-muted"}>{n}{label ? ` ${label}` : ""}</span> : null);
  const counts: Record<Tab, React.ReactNode> = { todo: count(todos.length), waiting: count(waits.length), updates: count(fresh, "new") };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar title="Inbox" icon={<SystemIcon page="inbox" />} />
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <div className="mx-auto flex w-full max-w-[820px] flex-col gap-2 px-6 pt-6 pb-10">
          <div className="mb-2">
            <Segmented
              items={(Object.keys(TABS) as Tab[]).map((t) => ({
                label: (
                  <>
                    {TABS[t]} {counts[t]}
                  </>
                ),
                href: t === "todo" ? "/inbox" : `/inbox?tab=${t}`,
                active: t === tab,
              }))}
            />
          </div>
          {tab === "todo" ? (
            <ToDoList
              caps={looks}
              items={todos.map((i) => ({
                key: `${i.waitId ?? "step"}:${i.rowId}`,
                href: rowHref(i),
                capabilityId: i.capabilityId,
                title: i.title,
                label: i.label ?? i.step,
                line: [i.label ? (i.step ?? i.rowName) : i.rowName, i.rule].filter(Boolean).join(" · "),
                dueToday: i.due === today,
              }))}
            />
          ) : tab === "waiting" ? (
            <WaitingList
              caps={looks}
              items={waits.map((w) => ({
                key: `${w.rowId}:${w.on}`,
                href: rowHref(w),
                capabilityId: w.capabilityId,
                title: w.title,
                on: w.on,
                label: w.label,
                line: w.step ?? "",
                since: formatDay(dayIn(w.since, ws.timeZone), formats),
              }))}
            />
          ) : (
            <>
              <UpdatesList caps={looks} items={updates.map((u) => ({ ...u, key: u.id, href: rowHref(u) }))} />
              <SeenUpdates />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
