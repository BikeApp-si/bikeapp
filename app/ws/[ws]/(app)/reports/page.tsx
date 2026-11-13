import { SystemIcon } from "@/components/shell/system-icon";
import Link from "next/link";
import { BarChart3, Clock, LayoutGrid, Mail } from "lucide-react";
import { CHECK, Grid, Head, NO_TOOLBAR, ROW } from "@/components/table/table";
import { connection } from "next/server";
import { TopBar } from "@/components/shell/top-bar";
import { asPage } from "@/server/auth/kernel-call";
import { currentWorkspace, requireAdmin } from "@/server/auth/current";
import { listSaved } from "@/server/kernel/report/saved";

// M33 (m33-d), admins only: the reports this admin saved, the one run most recently first, the apps each reads, how
// often it's emailed and its last run. A row opens its chat with the report in the panel. Nobody else's are listed.
export default async function ReportsPage({ params }: { params: Promise<{ ws: string }> }) {
  await connection();
  const wsParam = (await params).ws;
  await requireAdmin(await currentWorkspace(wsParam));
  const saved = await asPage(wsParam, (tx, ctx) => listSaved(tx, ctx));
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <TopBar title="Reports" icon={<SystemIcon page="reports" />} />
      <div className={`min-h-0 flex-1 overflow-auto pb-5 ${NO_TOOLBAR}`}>
        {saved.length ? (
          <Grid label="Reports">
            <thead>
              <tr>
                <th className={CHECK} />
                <Head icon={BarChart3}>Report</Head>
                <Head icon={LayoutGrid}>Apps</Head>
                <Head icon={Mail}>Emailed</Head>
                <Head icon={Clock}>Last run</Head>
              </tr>
            </thead>
            <tbody>
              {saved.map((s) => (
                <tr key={s.reportId} className={ROW}>
                  <td className={CHECK} />
                  <td className="font-medium !whitespace-normal">
                    <Link href={s.href} className="hover:text-primary-text">
                      {s.title}
                    </Link>
                  </td>
                  <td className="!whitespace-normal text-icon">{s.apps}</td>
                  <td className="!whitespace-normal">{s.emailed}</td>
                  <td className="text-muted">{s.lastRun}</td>
                </tr>
              ))}
            </tbody>
          </Grid>
        ) : null}
      </div>
    </div>
  );
}
