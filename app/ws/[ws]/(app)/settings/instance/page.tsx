import { connection } from "next/server";
import { notFound } from "next/navigation";
import { edition } from "@/edition";
import { SystemIcon } from "@/components/shell/system-icon";
import { TopBar } from "@/components/shell/top-bar";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { RunAgain } from "@/components/settings/run-again";
import { COLUMN, LABEL, LAST_ROW, ROW } from "@/components/settings/rows";
import { currentWorkspace, requireAdmin } from "@/server/auth/current";
import { instanceUrl } from "@/server/edition/open";
import { healthItems, type HealthItem } from "@/server/instance/health";
import { newerRelease } from "@/server/instance/updates";
import { cn } from "@/lib/utils";

// Settings › Instance, admins of the open Bike only (docs/design/o2/c-instance.png, c2; o4/a, b, c): what runs and
// whether a newer version is out, and whether what it needs answers, each failing item with how to fix it.
export default async function InstancePage({ params }: { params: Promise<{ ws: string }> }) {
  await connection();
  if (!edition.oneCompany()) notFound();
  const ws = await currentWorkspace((await params).ws);
  await requireAdmin(ws);
  const [items, newer] = await Promise.all([healthItems(ws.timeZone), newerRelease()]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar title="Settings" icon={<SystemIcon page="settings" />}>
        <SettingsTabs on="instance" />
      </TopBar>
      <div className="flex-1 overflow-auto px-8 pt-2 pb-5">
        <div className={COLUMN}>
          <div className={LABEL}>This Bike</div>
          <div className={cn(ROW, "items-start")}>
            <span className="flex-1 text-base">Version</span>
            <div className="flex flex-col items-end gap-1 text-right">
              <span className="text-base">{process.env.BIKE_VERSION || "dev"}</span>
              {newer ? (
                <>
                  <span className="text-[15px] text-muted" data-newer={newer.version}>
                    Bike {newer.version} is out.{" "}
                    <a href={newer.url} target="_blank" rel="noreferrer" className="text-primary-text underline decoration-primary-border underline-offset-[3px] hover:decoration-primary-text">
                      What changed
                    </a>
                  </span>
                  <span className="text-[15px] text-muted">To update, run sh update.sh {newer.version} on the server.</span>
                </>
              ) : null}
            </div>
          </div>
          <div className={LAST_ROW}>
            <span className="flex-1 text-base">Address</span>
            <span className="text-base">{instanceUrl().origin}</span>
          </div>
          <div className={cn(LABEL, "mt-4")}>
            Health · checked just now
            <RunAgain />
          </div>
          {items.map((it, i) => (
            <Item key={it.name} item={it} last={i === items.length - 1} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Item({ item, last }: { item: HealthItem; last: boolean }) {
  return (
    <div className={cn(last ? LAST_ROW : ROW, "items-start")} data-health={item.name} data-ok={item.ok}>
      <span className="w-44 shrink-0 text-base">{item.name}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className={cn("flex items-baseline gap-2 text-base", item.ok ? "text-ink" : "text-danger")}>
          <span aria-hidden className={cn("inline-block size-2 shrink-0 translate-y-[-1px] rounded-full", item.ok ? "bg-success" : "bg-danger")} />
          {item.says}
        </span>
        {item.fix ? <span className="pl-4 text-[15px] leading-normal text-muted">{item.fix}</span> : null}
      </div>
    </div>
  );
}
