import { SystemIcon } from "@/components/shell/system-icon";
import { Network, ScrollText } from "lucide-react";
import { Segmented } from "@/components/segmented";
import { cn } from "@/lib/utils";
import { CompanyRulesTab } from "@/components/ontology/company-rules-tab";
import { companyRulesView } from "@/server/chat/company-rules-view";
import { workspaces } from "@/db/schema";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { OntologyActions } from "@/components/ontology/ontology-actions";
import { OntologyBody } from "@/components/ontology/ontology-body";
import { TopBar } from "@/components/shell/top-bar";
import { capabilitiesFor } from "@/server/kernel/capabilities";
import { asPage } from "@/server/auth/kernel-call";
import { currentWorkspace, requireAdmin } from "@/server/auth/current";
import { currentTime } from "@/server/kernel/clock";
import { coherenceHash, readCoherence } from "@/server/kernel/coherence";
import { load } from "@/server/kernel/context";
import { hashOf, listOntologyVersions, ontologyInput, ontologyLine, ontologyView, pastBanner, pastInput, readOntology, readOntologyVersion, writtenWhen } from "@/server/kernel/ontology";
import { due } from "@/server/ontology/write";

// 4e, admins only (the kernel refuses everyone else too): how the company runs, written by prompt 6, and the
// kernel's breakdown. Out of date, the page asks for it to be written again. ?version=N shows a kept version read
// only (M34, m34-c), with the apps as it read them; the newest is the page itself.
export default async function OntologyPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ tab?: string; version?: string }> }) {
  await connection();
  const wsParam = (await params).ws;
  await requireAdmin(await currentWorkspace(wsParam));
  const q = await searchParams;
  const rules = q.tab === "rules";
  const company = rules
    ? await asPage(wsParam, async (tx, ctx) => companyRulesView(tx, ctx, (await tx.select({ name: workspaces.name }).from(workspaces))[0]!.name))
    : null;
  const asked = !rules && q.version !== undefined ? Number(q.version) : null;
  const now = currentTime();
  const { view, stale, line, versions, past } = await asPage(wsParam, async (tx, ctx) => {
    const input = await ontologyInput(tx, ctx);
    const stored = await readOntology(tx);
    const coherence = await readCoherence(tx);
    const loaded = await load(tx);
    const colors = new Map((await capabilitiesFor(tx, ctx)).map((c) => [c.name, c.color]));
    const versions = (await listOntologyVersions(tx, ctx)).map((v) => ({ version: v.version, when: writtenWhen(v.writtenAt, now, loaded.timeZone, loaded.formats), what: v.what }));
    const kept = asked !== null && asked !== stored?.version ? await readOntologyVersion(tx, ctx, asked) : null;
    if (kept) {
      const view = ontologyView({ ...input, ...(await pastInput(tx, ctx, kept.read)) }, kept, [], colors);
      const banner = pastBanner(kept.version, kept.writtenAt, view.each.map((c) => c.name), now, loaded.timeZone, loaded.formats);
      return { view, stale: false, line: ontologyLine(view, now, loaded.timeZone, loaded.formats, true), versions, past: { version: kept.version, banner } };
    }
    if (asked !== null && asked !== stored?.version) return null;
    const stale = input.capabilities.length > 0 && (due(stored, hashOf(input)) || coherence?.inputHash !== coherenceHash(input));
    const view = ontologyView(input, stored, coherence?.items, colors);
    return { view, stale, line: ontologyLine(view, now, loaded.timeZone, loaded.formats), versions, past: null };
  }).then((r) => r ?? notFound());
  return (
    // The Company rules tab keeps the header in place: the chat and the rules scroll on their own, as in Customize.
    <div className={cn("relative flex min-h-0 flex-col", rules ? "h-screen min-h-[480px] flex-none" : "flex-1")}>
      <TopBar title="Ontology" icon={<SystemIcon page="ontology" />}>
        <Segmented
          items={[
            { label: <><Network size={14} strokeWidth={1.8} />Ontology</>, href: "/ontology", active: !rules },
            { label: <><ScrollText size={14} strokeWidth={1.8} />Company rules</>, href: "/ontology?tab=rules", active: rules },
          ]}
        />
        {rules ? null : <OntologyActions version={view.version} stale={stale} versions={versions} past={past?.version ?? null} />}
      </TopBar>
      {company ? <CompanyRulesTab initial={company} /> : <OntologyBody view={view} line={line} past={past ?? undefined} />}
    </div>
  );
}
