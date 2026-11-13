import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { aiCalls, capabilities, people } from "@/db/schema";
import { mustBeAdmin } from "@/server/kernel/admin";
import type { KernelCtx } from "@/server/kernel/context";
import type { Tx } from "@/server/kernel/tx";
import { currentTime } from "@/server/kernel/clock";

// Settings › AI's "This month" (O3, docs/design/o3/a-ai-tab.png): the company's AI calls this calendar month (UTC),
// their cost in dollars at Anthropic's list prices (server/ai/prices.ts, logged with each call), what they were
// for and the newest ones. The open Bike's monthly cap reads the same total.

const PURPOSE: Record<string, string> = {
  "workspace-planner": "Building and changing apps", "capability-designer": "Building and changing apps", "logic-writer": "Building and changing apps",
  "import-mapping": "Building and changing apps", "import-question": "Building and changing apps", "customize-planner": "Building and changing apps",
  "customize-router": "Building and changing apps", "customize-guide": "Building and changing apps", "customize-advisor": "Building and changing apps",
  "customize-suggestions": "Building and changing apps", "company-rule-writer": "Building and changing apps",
  "report-writer": "Reports", "report-sentence": "Reports",
  "tutorial-writer": "How to use",
  "ontology-writer": "Ontology", "coherence-check": "Ontology",
  "filter-words": "Filters and forms", "read-into-fields": "Filters and forms",
  "setup-reader": "Setup",
  "ai-step": "AI steps",
};
// One call's "what", before its app's name: "Customize · Customer contracts".
const WHAT: Record<string, string> = {
  "workspace-planner": "Building", "capability-designer": "Building", "logic-writer": "Building", "import-mapping": "Importing", "import-question": "Importing",
  "customize-planner": "Customize", "customize-router": "Customize", "customize-guide": "Customize", "customize-advisor": "Customize",
  "customize-suggestions": "Customize", "company-rule-writer": "Company rules", "report-writer": "Report", "report-sentence": "Report",
  "tutorial-writer": "How to use", "ontology-writer": "Ontology", "coherence-check": "Ontology", "filter-words": "Filters",
  "read-into-fields": "Reading a document", "setup-reader": "Setup", "ai-step": "AI step",
};
export const purposeOf = (prompt: string) => PURPOSE[prompt] ?? "Other";

export function monthOf(now: Date): { start: Date; end: Date } {
  return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
}

// This month's dollars, for the cap (inside the company's own transaction).
export async function spentThisMonth(tx: Tx, now = currentTime()): Promise<number> {
  const { start, end } = monthOf(now);
  const [r] = await tx.select({ usd: sql<string>`coalesce(sum(${aiCalls.costUsd}), 0)` }).from(aiCalls).where(and(gte(aiCalls.at, start), lt(aiCalls.at, end)));
  return Number(r?.usd ?? 0);
}

export type AiUse = {
  from: Date;
  usd: number;
  byPurpose: { what: string; calls: number; usd: number }[];
  newest: { at: Date; what: string; who: string; usd: number }[];
};

// Admins only, like the rest of Settings.
export async function aiUse(tx: Tx, ctx: KernelCtx, now = currentTime()): Promise<AiUse> {
  await mustBeAdmin(tx, ctx);
  const { start, end } = monthOf(now);
  const calls = await tx
    .select({ prompt: aiCalls.prompt, usd: aiCalls.costUsd, at: aiCalls.at, who: people.name, app: capabilities.name })
    .from(aiCalls)
    .leftJoin(people, eq(people.id, aiCalls.personId))
    .leftJoin(capabilities, eq(capabilities.id, aiCalls.capabilityId))
    .where(and(gte(aiCalls.at, start), lt(aiCalls.at, end)))
    .orderBy(desc(aiCalls.at));
  const groups = new Map<string, { what: string; calls: number; usd: number }>();
  let usd = 0;
  for (const c of calls) {
    const what = purposeOf(c.prompt);
    const g = groups.get(what) ?? { what, calls: 0, usd: 0 };
    g.calls++;
    g.usd += Number(c.usd);
    usd += Number(c.usd);
    groups.set(what, g);
  }
  return {
    from: start,
    usd,
    byPurpose: [...groups.values()].sort((a, b) => b.usd - a.usd || a.what.localeCompare(b.what)),
    newest: calls.slice(0, 20).map((c) => ({ at: c.at, what: c.app ? `${WHAT[c.prompt] ?? "Other"} · ${c.app}` : (WHAT[c.prompt] ?? "Other"), who: c.who ?? "Bike", usd: Number(c.usd) })),
  };
}
