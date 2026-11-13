import { SystemIcon } from "@/components/shell/system-icon";
import { TopBar } from "@/components/shell/top-bar";
import { connection } from "next/server";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { listedSets } from "@/server/gallery/list";
import { redirect } from "next/navigation";
import { CapIcon } from "@/components/cap-icon";
import { capColor } from "@/lib/cap-colors";
import { ChatView } from "@/components/chat/chat-view";
import { HomeBox } from "@/components/home/home-box";
import { NeedsModel } from "@/components/no-model";
import { NO_MODEL } from "@/lib/messages";
import { hasModel } from "@/server/kernel/instance-settings";
import { chatView } from "@/server/chat/view";
import { DoItYourself } from "@/components/home/do-it-yourself";
import { RecentChats } from "@/components/chats/recent-chats";
import { listChats } from "@/server/kernel/chat-list";
import { chatPlace } from "@/server/kernel/chats";
import { dailyHeading, firstName, partOfDay } from "@/lib/greeting";
import { asPage } from "@/server/auth/kernel-call";
import { currentWorkspace, requirePerson } from "@/server/auth/current";
import { doItYourself } from "@/server/kernel/actions";
import { capabilitiesFor, hasCapabilities } from "@/server/kernel/capabilities";
import { todayIn } from "@/server/kernel/context";
import { setupDone } from "@/server/kernel/setup/state";
import { currentTime } from "@/server/kernel/clock";

// Example chips while the workspace has no capabilities (developer notes §3).
const CHIPS = ["Customer contracts and renewals", "A hiring pipeline", "Equipment lent to people", "Expense approvals by amount"];

// 3a / 12a (admin, with recent chats) and 3a1 (employee); an admin's chat opens here too (?chat=, 5b–5l, 11a–12d).
export default async function HomePage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ chat?: string; import?: string; ask?: string; report?: string }> }) {
  await connection();
  const wsParam = (await params).ws;
  const ws = await currentWorkspace(wsParam);
  const person = await requirePerson(ws);
  // Until setup is done, an admin's Home is setup (2b–2e).
  if (person.isAdmin && !(await asPage(wsParam, (tx) => setupDone(tx)))) redirect("/setup");
  const { chat: chatId, import: importInto, ask, report } = await searchParams;
  if (person.isAdmin && chatId) {
    // A Customize or Company rules chat opens in its own place (#12).
    const place = await asPage(wsParam, (tx, ctx) => chatPlace(tx, ctx, chatId));
    if (place) redirect(place);
    const view = await asPage(wsParam, (tx, ctx) => chatView(tx, ctx, chatId));
    return <ChatView key={chatId} initial={view} openReport={report} />;
  }
  const first = firstName(person.name);
  const { actions, anyCapability, into, recent } = await asPage(wsParam, async (tx, ctx) => ({
    actions: await doItYourself(tx, ctx),
    recent: person.isAdmin ? await listChats(tx, ctx, { limit: 5 }) : [],
    anyCapability: await hasCapabilities(tx),
    // 5i's Import a spreadsheet: a capability the admin can see, to import a file into.
    into: person.isAdmin && importInto ? (await capabilitiesFor(tx, ctx)).find((c) => c.id === importInto) : undefined,
  }));
  const items = actions.map((a) => ({ ...a, icon: <CapIcon name={a.icon} size={16} strokeWidth={1.8} color={capColor(a.color)} /> }));
  const empty = person.isAdmin && !anyCapability;

  const model = await hasModel();
  const sets = listedSets().length > 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar plain title="Home" icon={<SystemIcon page="home" />} />
    {/* Centred by its own auto margins, never by the scrolling area: on a short window the top stays reachable, a fixed
        40 px under the top bar (#4). */}
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="m-auto flex w-full max-w-[1080px] flex-col gap-5 px-6 pt-10 pb-10">
        <div className="flex flex-col items-center gap-2.5 pt-6 pb-2">
          {person.isAdmin ? (
            <>
              <h1 className="m-0 text-[28px] font-semibold">
                {empty ? `What should Bike run for you next, ${first}?` : dailyHeading(person.id, todayIn(ws.timeZone), first, ws.shortName)}
              </h1>
              {/* O3 (d-home-no-model): with no model, the chat gives way to the app sets. */}
              {!model ? (
                <>
                  <NeedsModel line={NO_MODEL.home} admin after={sets ? ", or start from an app set: ready-made apps, no AI used." : "."} className="w-full max-w-[608px]" />
                  {sets ? (
                    <Link href="/gallery" className="mt-1.5 inline-flex h-9 items-center rounded-[6px] bg-primary px-4 text-[15px] font-medium text-white hover:bg-primary-hover">
                      Start from an app set
                    </Link>
                  ) : null}
                </>
              ) : (
              <HomeBox empty={empty} chips={empty ? CHIPS : []} into={into ? { id: into.id, name: into.name } : undefined} ask={ask?.slice(0, 500)} />
              )}
              {/* G2 (g2-c): the gallery, when it has a set. */}
              {model && sets ? (
                <Link href="/gallery" className="mt-1.5 inline-flex items-center gap-1.5 text-[15px] font-medium text-primary-text hover:text-primary-hover">
                  Or start from an app set <ArrowRight size={15} />
                </Link>
              ) : null}
            </>
          ) : (
            <h1 className="m-0 text-[28px] font-semibold">Good {partOfDay(currentTime(), ws.timeZone)}, {first}</h1>
          )}
        </div>
        {empty ? null : (
          <>
            <DoItYourself actions={items} />
            <RecentChats chats={recent} />
          </>
        )}
      </div>
    </div>
    </div>
  );
}
