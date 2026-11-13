"use client";

import { SystemIcon } from "@/components/shell/system-icon";
import { TopBar } from "@/components/shell/top-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlignLeft, Clock, Download, LayoutGrid, User, Zap } from "lucide-react";
import { CHECK, Grid, Head, QUIET_PICKER, ROW, SearchBox, TOOLBAR, UNDER_TOOLBAR } from "@/components/table/table";
import { Picker } from "@/components/picker";
import { detailsText } from "@/lib/audit-text";
import { formatUtc } from "@/lib/format";
import { loadAudit } from "@/app/ws/[ws]/(app)/audit/actions";
import type { AuditRow } from "@/server/kernel/audit";

type Props = {
  first: { entries: AuditRow[]; matching: number; total: number };
  capabilities: { id: string; name: string }[];
  people: string[];
};

const ALL = "__all__";

// 9a: every entry as recorded, newest first; an entry from one of the admin's chats links to it (12f). Search, a capability and a person filter, Download CSV, and
// "N of total events". Loads 100 more as the table scrolls.
export function AuditTable({ first, capabilities, people }: Props) {
  const [entries, setEntries] = useState(first.entries);
  const [counts, setCounts] = useState({ matching: first.matching, total: first.total });
  const [search, setSearch] = useState("");
  const [capabilityId, setCapability] = useState<string | null>(null);
  const [who, setWho] = useState<string | null>(null);
  const busy = useRef(false);
  const filter = { search: search || undefined, capabilityId: capabilityId ?? undefined, who: who ?? undefined };
  const key = JSON.stringify(filter);

  useEffect(() => {
    const t = setTimeout(async () => {
      const r = await loadAudit(JSON.parse(key), 0);
      if (r.ok) (setEntries(r.entries), setCounts({ matching: r.matching, total: r.total }));
    }, 200);
    return () => clearTimeout(t);
  }, [key]);

  const more = useCallback(async () => {
    if (busy.current || entries.length >= counts.matching) return;
    busy.current = true;
    const r = await loadAudit(JSON.parse(key), entries.length);
    busy.current = false;
    if (r.ok) setEntries((old) => [...old, ...r.entries]);
  }, [key, entries.length, counts.matching]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && void more());
    if (end.current) io.observe(end.current);
    return () => io.disconnect();
  }, [more]);

  const csv = `/audit/csv?${new URLSearchParams(Object.entries({ search, capability: capabilityId ?? "", who: who ?? "" }).filter(([, v]) => v))}`;

  return (
    <>
      <TopBar title="Audit log" icon={<SystemIcon page="audit" />}>
        <a href={csv} download className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-line bg-white px-3 text-[15px] font-medium text-ink hover:bg-page">
          <Download size={16} strokeWidth={1.8} className="text-icon" />
          Download CSV
        </a>
      </TopBar>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto pb-5">
        <div className={TOOLBAR}>
          <SearchBox lead label="Search the log" value={search} onChange={setSearch} />
          <Picker
            label="App"
            className={QUIET_PICKER}
            value={capabilityId ?? ALL}
            onChange={(id) => setCapability(id === ALL ? null : id)}
            options={[{ id: ALL, label: "All apps" }, ...capabilities.map((c) => ({ id: c.id, label: c.name }))]}
          />
          <Picker
            label="Person"
            className={QUIET_PICKER}
            value={who ?? ALL}
            onChange={(id) => setWho(id === ALL ? null : id)}
            options={[{ id: ALL, label: "All people" }, ...people.map((p) => ({ id: p, label: p }))]}
          />
          <span className="flex-1" />
          <span className="text-[14px] text-muted">
            {counts.matching.toLocaleString("en-US")} of {counts.total.toLocaleString("en-US")} events · admins only
          </span>
        </div>
        <div style={UNDER_TOOLBAR}>
          <Grid label="Audit log">
            <thead>
              <tr>
                <th className={CHECK} />
                <Head icon={Clock}>Time (UTC)</Head>
                <Head icon={User}>Who</Head>
                <Head icon={LayoutGrid}>App</Head>
                <Head icon={Zap}>Event</Head>
                <Head icon={AlignLeft}>Details</Head>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className={ROW}>
                  <td className={CHECK} />
                  <td className="font-mono text-sm text-muted">{formatUtc(new Date(e.at))}</td>
                  <td>{e.who}</td>
                  <td>{e.capability ?? "—"}</td>
                  <td className="font-mono text-sm text-primary-text">{e.event}</td>
                  <td className="py-[7px] font-mono text-sm !whitespace-normal break-words text-ink">
                    {detailsText(e.details)}
                    {e.chatId ? (
                      <>
                        {" · "}
                        <Link href={`/home?chat=${e.chatId}`} className="font-sans font-medium text-primary-text hover:text-primary-hover">
                          View chat
                        </Link>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </Grid>
          <div ref={end} />
        </div>
      </div>
    </>
  );
}
