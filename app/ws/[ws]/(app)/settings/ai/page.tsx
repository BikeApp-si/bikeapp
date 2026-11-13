import { connection } from "next/server";
import { notFound } from "next/navigation";
import { edition } from "@/edition";
import { SystemIcon } from "@/components/shell/system-icon";
import { TopBar } from "@/components/shell/top-bar";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { AiSettings, type KeyShown } from "@/components/settings/ai-settings";
import { COLUMN, LABEL, LAST_ROW, ROW } from "@/components/settings/rows";
import { asPage } from "@/server/auth/kernel-call";
import { currentWorkspace, requireAdmin } from "@/server/auth/current";
import { aiUse, type AiUse } from "@/server/ai/use";
import { checkAnthropicKey } from "@/server/ai/key-check";
import { aiKey, aiKeyView } from "@/server/kernel/instance-settings";
import { currentTime } from "@/server/kernel/clock";
import { cn } from "@/lib/utils";

// Settings › AI, admins of the open Bike only (O3, docs/design/o3/a-ai-tab.png, a2): the company's Anthropic key, the
// monthly cap, and this month's AI use in dollars.
export default async function AiPage({ params }: { params: Promise<{ ws: string }> }) {
  await connection();
  if (!edition.oneCompany()) notFound();
  const wsParam = (await params).ws;
  const ws = await currentWorkspace(wsParam);
  await requireAdmin(ws);
  const now = currentTime();
  const use = await asPage(wsParam, (tx, ctx) => aiUse(tx, ctx, now));
  const view = await aiKeyView();
  const key = await aiKey();
  const works = key ? await worksLine(key.key) : null;
  const shown: KeyShown = { ...view, works };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar title="Settings" icon={<SystemIcon page="settings" />}>
        <SettingsTabs on="ai" />
      </TopBar>
      <div className="flex-1 overflow-auto px-8 pt-2 pb-5">
        <div className={COLUMN}>
          <AiSettings k={shown} cap={view.cap} />
          <Month use={use} cap={view.cap} now={now} timeZone={ws.timeZone} hasKey={!!key} />
        </div>
      </div>
    </div>
  );
}

async function worksLine(key: string): Promise<string> {
  const checked = await checkAnthropicKey(key);
  if (checked === "ok") return "It works: checked just now.";
  if (checked === "refused") return "Anthropic refused it: replace it.";
  return "Anthropic couldn’t be asked just now.";
}

const money = (n: number) => `$${n.toFixed(2)}`;
const capText = (n: number) => `$${n % 1 ? n.toFixed(2) : n}`;

function Month({ use, cap, now, timeZone, hasKey }: { use: AiUse; cap: number | null; now: Date; timeZone: string; hasKey: boolean }) {
  const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const span = `${day.format(use.from)}–${new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: "UTC" }).format(now)}`;
  const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone });
  return (
    <>
      <div className={cn(LABEL, "mt-4")}>
        This month · {span}
        {use.usd > 0 ? <span className="text-ink">{cap === null ? money(use.usd) : `${money(use.usd)} of ${capText(cap)}`}</span> : null}
      </div>
      {cap !== null && use.usd > 0 ? (
        <div className="mt-2 mb-1.5 h-1.5 rounded-full bg-fill">
          <div className="h-1.5 rounded-full bg-primary" style={{ width: `${Math.min(100, (use.usd / cap) * 100)}%` }} />
        </div>
      ) : null}
      {use.byPurpose.length ? (
        use.byPurpose.map((p, i) => (
          <div key={p.what} className={i === use.byPurpose.length - 1 ? LAST_ROW : ROW}>
            <span className="flex-1 text-base">{p.what}</span>
            <span className="text-[15px] text-muted">
              {p.calls} {p.calls === 1 ? "call" : "calls"}
            </span>
            <span className="w-20 text-right text-base">{money(p.usd)}</span>
          </div>
        ))
      ) : (
        <div className={LAST_ROW}>
          <span className="text-base">No AI used yet.</span>
        </div>
      )}
      {use.newest.length ? (
        <>
          <div className={cn(LABEL, "mt-4")}>Newest calls</div>
          {use.newest.map((c, i) => (
            <div key={i} className={cn(i === use.newest.length - 1 ? LAST_ROW : ROW, "text-[15px]")}>
              <span className="w-32 shrink-0 text-muted">{when.format(c.at)}</span>
              <span className="flex-1">{c.what}</span>
              <span className="w-40 shrink-0 text-muted">{c.who}</span>
              <span className="w-20 text-right">{money(c.usd)}</span>
            </div>
          ))}
          <div className="mt-3 text-[14px] text-muted">Costs at Anthropic’s list prices. Your Anthropic bill is the final word.</div>
        </>
      ) : null}
      {hasKey ? null : (
        <>
          <div className={cn(LABEL, "mt-4")}>Without a key</div>
          <div className="text-[15px] leading-[1.6] text-muted">
            Everything works except what needs an AI model: building and changing apps from words or documents, reports from questions, filters in plain words, reading a dropped
            document into a form, and each app’s How to use. Apps can come from an app set instead.
          </div>
        </>
      )}
    </>
  );
}
