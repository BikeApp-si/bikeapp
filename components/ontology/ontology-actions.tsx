"use client";

import { Download, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { regenerateOntology } from "@/app/ws/[ws]/(app)/ontology/actions";
import { Button } from "@/components/buttons";
import { cn } from "@/lib/utils";
import { useModel } from "@/components/no-model";
import { OntologyVersions, outlined, type VersionRow } from "./ontology-versions";

// Versions (M34), Download and Regenerate (4e). A past version (m34-c) downloads itself and can't be regenerated. Regenerating, or a page that is out of date, asks for a new version and looks
// again every few seconds until it is there (or two minutes pass: nothing had changed, or it couldn't be written).
export function OntologyActions({ version, stale: outOfDate, versions, past }: { version: number | null; stale: boolean; versions: VersionRow[]; past: number | null }) {
  const router = useRouter();
  // With no model (O3) the Ontology isn't written again: no Regenerate, and an out-of-date page doesn't ask.
  const model = useModel();
  const stale = outOfDate && !model.none;
  // Waiting for a version newer than `from`; done once the page shows one.
  const [asked, setAsked] = useState<{ from: number | null } | null>(stale ? { from: version } : null);
  const waiting = asked !== null && version === asked.from;

  const regenerate = async () => {
    setAsked({ from: version });
    await regenerateOntology();
  };

  // An out-of-date page asks once, when it opens.
  useEffect(() => {
    if (stale) void regenerateOntology();
  }, [stale]);

  useEffect(() => {
    if (!waiting) return;
    const tick = setInterval(() => router.refresh(), 3000);
    const stop = setTimeout(() => setAsked(null), 120_000);
    return () => {
      clearInterval(tick);
      clearTimeout(stop);
    };
  }, [waiting, router]);

  return (
    <div className="flex items-center gap-2.5">
      {versions.length ? <OntologyVersions versions={versions} showing={past ?? version} /> : null}
      <a href={past ? `/ontology/download?version=${past}` : "/ontology/download"} className={outlined}>
        <Download size={16} strokeWidth={2} />
        {past ? `Download version ${past}` : "Download"}
      </a>
      {past || model.none ? null : (
        <Button className="h-8" disabled={waiting} onClick={() => void regenerate()}>
          <RefreshCw size={16} strokeWidth={2} className={cn(waiting && "animate-spin")} />
          Regenerate
        </Button>
      )}
    </div>
  );
}
