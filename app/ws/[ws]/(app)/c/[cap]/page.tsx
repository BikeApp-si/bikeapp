import { NewButton } from "@/components/data/new-button";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Plus, Table2 } from "lucide-react";
import { CapIcon } from "@/components/cap-icon";
import { Segmented } from "@/components/segmented";
import { TopBar } from "@/components/shell/top-bar";
import { TutorialCard, TutorialLink, TutorialProvider } from "@/components/tutorial/tutorial";
import { capabilities } from "@/db/schema";
import { eq } from "drizzle-orm";
import { capColor } from "@/lib/cap-colors";
import { CapabilityMenu } from "@/components/data/capability-menu";
import { CustomizeTab } from "@/components/customize/customize-tab";
import { DataTab } from "@/components/data/data-tab";
import { tablePrefsFor, viewsFor } from "@/server/kernel/saved-views";
import { RoleViewTable } from "@/components/data/role-view";
import { cn } from "@/lib/utils";
import { asPage } from "@/server/auth/kernel-call";
import { customizeView } from "@/server/chat/customize-view";
import { currentWorkspace, requirePerson } from "@/server/auth/current";
import { AccessError, load, todayIn, type KernelCtx } from "@/server/kernel/context";
import { titleShown } from "@/server/kernel/commands";
import type { Sheet } from "@/server/kernel/schema/file";
import type { Tx } from "@/server/kernel/tx";
import { renderDefaultHint } from "@/server/kernel/expr/render";
import { getRow, listRows, sheetTotals } from "@/server/kernel/rows";
import { capabilityView, namesFor, peoplePicker, roleViewFor } from "@/server/kernel/views";
import { proposalsFor, waitingBelowSuggestions } from "@/server/kernel/proposals";
import { waitingRowIds, waitsOnRows } from "@/server/kernel/waiting";
import { panelRow } from "./panel";

// The Customize icon: three squares in an L with a fourth set apart (developer notes §1).
function CustomizeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10a1 1 0 0 1 1-1h5v6H3z" />
      <path d="M3 15h6v6H4a1 1 0 0 1-1-1z" />
      <path d="M9 15h6v5a1 1 0 0 1-1 1H9z" />
      <rect width="7" height="7" x="14" y="3" rx="1.5" />
    </svg>
  );
}

// A capability: header, then the Data tab (6a) for everyone with access; Customize (6b–6l) for admins.
export default async function CapabilityPage({ params, searchParams }: { params: Promise<{ ws: string; cap: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  await connection();
  const { ws: wsParam, cap: capId } = await params;
  const q = await searchParams;
  const ws = await currentWorkspace(wsParam);
  const person = await requirePerson(ws);

  const data = await asPage(wsParam, async (tx, ctx) => {
    const view = await capabilityView(tx, ctx, capId).catch((e) => {
      if (e instanceof AccessError) return null;
      throw e;
    });
    if (!view) return null;
    // A role's own table (8a–8e, X1) in place of the Data tab, when the person has one.
    const roleView = await roleViewFor(tx, ctx, capId, person.isAdmin);
    const sheet = view.sheets.find((s) => s.id === (roleView?.sheet ?? q.sheet)) ?? view.sheets[0]!;
    const full = (await load(tx)).files.get(capId)!.file.sheets.find((s) => s.id === sheet.id)!;
    // Waiting on me: the rows of this sheet waiting on the person, and the filter when it is on.
    const waitingIds = await waitingRowIds(tx, ctx, capId, sheet.id);
    const on = q.waiting === "1";
    // 8h: the suggestions waiting on this person come first; the table below lists the rest.
    const suggestions = on ? (await proposalsFor(tx, ctx, capId)).filter((p) => p.sheetId === sheet.id) : [];
    const only = on ? await waitingBelowSuggestions(tx, ctx, capId, sheet.id) : undefined;
    // Saved views (0.4): the sheet's views and the person's columns; the view named in the address opens first.
    const saved = roleView ? null : { views: await viewsFor(tx, ctx, capId, sheet.id), prefs: await tablePrefsFor(tx, ctx, capId, sheet.id) };
    const openView = saved?.views.find((v) => v.id === q.view) ?? null;
    const viewed = openView ? { filters: openView.filters, sort: openView.sort ?? undefined } : {};
    const rows = await listRows(tx, ctx, capId, sheet.id, { limit: 100, only, ...viewed });
    // The hint under a field whose default is worked out (7c: "Leave empty for one year after Start.").
    const render = { column: (id: string) => full.columns.find((x) => x.id === id), otherColumn: () => ({ sheet: "", column: "" }) };
    const hints = Object.fromEntries(full.columns.flatMap((c) => (c.default?.kind === "expr" ? [[c.id, renderDefaultHint(c.default.expr, render)]] : [])));
    // The row named in the address, when the person may see it and it is on this sheet.
    const named = q.row ? await panelRow(tx, ctx, q.row).catch((e) => (e instanceof AccessError ? null : Promise.reject(e))) : null;
    const open = named && named.row.capabilityId === capId && named.row.sheetId === sheet.id ? named : q.new === "1" ? { isNew: true as const } : null;
    return {
      saved,
      openViewId: openView?.id ?? null,
      view,
      roleView,
      sheet,
      open,
      first: {
        rows,
        names: await namesFor(tx, ctx, full, rows),
        totals: await sheetTotals(tx, ctx, capId, sheet.id, { only, filters: openView?.filters }),
        waits: await waitsOnRows(tx, ctx, capId, sheet.id, rows.map((r) => r.id)),
      },
      waiting: { on, all: await sheetTotals(tx, ctx, capId, sheet.id).then((t) => t.count), count: waitingIds.length },
      suggestions,
      people: await peoplePicker(tx),
      hints,
      // Its tutorial card may show (0.4, M24): created from now on, or changed since.
      introduce: (await tx.select({ introduce: capabilities.introduce }).from(capabilities).where(eq(capabilities.id, capId)))[0]?.introduce ?? false,
      // "+ Add renewal" from a contract (0.4, M22): the new row starts linked to it, when it's one the person may see.
      linked: q.new === "1" && q.link ? await linkedFrom(tx, ctx, full, q.link) : null,
      // The Customize tab (6b–6l), for admins only; the kernel checks it too.
      customize: q.tab === "customize" && person.isAdmin ? await customizeView(tx, ctx, capId) : null,
    };
  });
  if (!data) notFound();
  const { view, sheet, roleView } = data;
  const customize = q.tab === "customize" && person.isAdmin;

  return (
    // Customize keeps the header in place: the chat and the text scroll on their own (6c).
    <div className={cn("relative flex min-h-0 flex-col", customize ? "h-screen min-h-[480px] flex-none" : "flex-1")}>
      <TutorialProvider capId={capId} capName={view.name} introduce={data.introduce && !customize}>
      <TopBar title={view.name} icon={<CapIcon name={view.icon} size={16} strokeWidth={1.8} color={capColor(view.color)} />}>
        {roleView && sheet.canAdd ? (
          <Link href="?new=1" className="inline-flex h-8 items-center gap-1.5 rounded-[6px] bg-primary px-3 text-[15px] font-medium text-white hover:bg-primary-hover">
            <Plus size={14} strokeWidth={2} />
            {sheet.addAction}
          </Link>
        ) : null}
        {!roleView && !customize && sheet.canAdd ? <NewButton label={sheet.addAction} /> : null}
        {person.isAdmin ? (
          <Segmented
            items={[
              { label: "Data", href: `/c/${capId}`, active: !customize },
              { label: "Customize", href: `/c/${capId}?tab=customize`, active: customize },
            ]}
          />
        ) : null}
        <TutorialLink />
        {person.isAdmin ? <CapabilityMenu capId={capId} name={view.name} sheetCount={view.sheets.length} /> : null}
      </TopBar>
      {customize && data.customize ? (
        <CustomizeTab key={capId} initial={data.customize} people={data.people} ask={typeof q.ask === "string" ? q.ask.slice(0, 300) : undefined} />
      ) : roleView ? (
        <div className="flex-1 overflow-auto">
          <RoleViewTable
            key={`${sheet.id}:${data.waiting.on}`}
            capId={capId}
            capName={view.name}
            view={roleView}
            sheet={sheet}
            first={data.first}
            people={data.people}
            me={person.id}
            today={todayIn(ws.timeZone)}
            hints={data.hints}
            waiting={data.waiting}
            open={data.open ? ("isNew" in data.open ? (sheet.canAdd ? { mode: "new" } : null) : { mode: "view", row: data.open.row, moves: data.open.moves, wait: data.open.wait, line: data.open.line }) : null}
            tutorial={<TutorialCard capId={capId} />}
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-auto pb-6">
          <DataTab
            // A settled suggestion moves its row into the table below: start the table again with it.
            key={`${sheet.id}:${data.waiting.on}:${data.suggestions.length}`}
            capId={capId}
            capName={view.name}
            capIcon={<CapIcon name={view.icon} size={22} strokeWidth={1.8} color={capColor(view.color)} />}
            isAdmin={person.isAdmin}
            sheets={view.sheets.map((s) => ({ id: s.id, name: s.name, count: s.count }))}
            sheet={sheet}
            first={data.first}
            people={data.people}
            me={person.id}
            today={todayIn(ws.timeZone)}
            hints={data.hints}
            open={data.open}
            linked={data.linked}
            tutorial={<TutorialCard capId={capId} />}
            waiting={data.waiting}
            suggestions={data.suggestions}
            saved={data.saved ?? { views: [], prefs: null }}
            openViewId={data.openViewId}
          />
        </div>
      )}
      </TutorialProvider>
    </div>
  );
}

// ?link=contract:<row id>: a link column of this sheet, and a row the person may see, by its title. Anything else is
// left out (the kernel checks the link again on Create).
async function linkedFrom(tx: Tx, ctx: KernelCtx, sheet: Sheet, param: string) {
  const [columnId, rowId] = param.split(":");
  const column = sheet.columns.find((c) => c.id === columnId && c.type === "link");
  if (!column || !rowId || !/^[0-9a-f-]{36}$/.test(rowId)) return null;
  const row = await getRow(tx, ctx, rowId).catch((e) => (e instanceof AccessError ? null : Promise.reject(e)));
  const target = row && (await load(tx)).files.get(row.capabilityId)?.file.sheets.find((s) => s.id === row.sheetId);
  if (!row || !target || target.id !== column.link?.sheet) return null;
  const title = titleShown(target, row.data, await namesFor(tx, ctx, target, [row]));
  return { values: { [column.id]: row.id }, names: { [row.id]: title }, back: `/c/${row.capabilityId}?sheet=${row.sheetId}&row=${row.id}` };
}

