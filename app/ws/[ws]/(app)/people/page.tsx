import { Users } from "lucide-react";
import { connection } from "next/server";
import { PeopleView } from "@/components/people/people-view";
import { tintAt } from "@/lib/avatar";
import { asPage } from "@/server/auth/kernel-call";
import { currentWorkspace, requirePerson } from "@/server/auth/current";
import { listPeople, teamsOf, workspaceToday } from "@/server/kernel/directory";

// 7f and 7g, for everyone, and the Org chart (M28); Add a person and Import CSV for admins.
export default async function PeoplePage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ new?: string; tab?: string }> }) {
  await connection();
  const wsParam = (await params).ws;
  const ws = await currentWorkspace(wsParam);
  const me = await requirePerson(ws);
  const { people, teams, today, timeZone } = await asPage(wsParam, async (tx) => ({
    people: (await listPeople(tx)).map((p, i) => ({ ...p, tint: tintAt(i) })),
    teams: await teamsOf(tx),
    ...(await workspaceToday(tx)),
  }));
  const q = await searchParams;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <PeopleView people={people} teams={teams} isAdmin={me.isAdmin} today={today} timeZone={timeZone} addOpen={q.new === "1"} chart={q.tab === "chart"} />
    </div>
  );
}
