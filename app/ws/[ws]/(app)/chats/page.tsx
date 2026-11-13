import { SystemIcon } from "@/components/shell/system-icon";
import Link from "next/link";
import { Clock, LayoutGrid, MessageCircle, Sparkles } from "lucide-react";
import { CHECK, Grid, Head, NO_TOOLBAR, ROW } from "@/components/table/table";
import { connection } from "next/server";
import { TopBar } from "@/components/shell/top-bar";
import { asPage } from "@/server/auth/kernel-call";
import { currentWorkspace, requireAdmin } from "@/server/auth/current";
import { listChats, searchChats, type FoundChat } from "@/server/kernel/chat-list";
import { ChatSearch } from "@/components/chats/chat-search";

// 12b, admins only: every conversation with Bike, what it did and the capabilities it touched. Only the
// admin who wrote a chat sees it. M33 (m33-f): a search over their titles and messages, with the line that matched.
export default async function ChatsPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ q?: string }> }) {
  await connection();
  const wsParam = (await params).ws;
  await requireAdmin(await currentWorkspace(wsParam));
  const q = ((await searchParams).q ?? "").slice(0, 200);
  const chats: (FoundChat | Awaited<ReturnType<typeof listChats>>[number])[] = await asPage(wsParam, (tx, ctx) => (q.trim() ? searchChats(tx, ctx, q) : listChats(tx, ctx)));
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <TopBar title="Chats" icon={<SystemIcon page="chats" />}>
        <ChatSearch initial={q} />
      </TopBar>
      <div className={`min-h-0 flex-1 overflow-auto pb-5 ${NO_TOOLBAR}`}>
        {chats.length ? (
          <Grid label="Chats">
            <thead>
              <tr>
                <th className={CHECK} />
                <Head icon={MessageCircle}>Chat</Head>
                <Head icon={Sparkles}>What it did</Head>
                <Head icon={LayoutGrid}>Apps</Head>
                <Head icon={Clock}>Last message</Head>
              </tr>
            </thead>
            <tbody>
              {chats.map((c) => (
                <tr key={c.id} className={ROW}>
                  <td className={CHECK} />
                  <td className="font-medium !whitespace-normal">
                    <Link href={c.href} className="hover:text-primary-text">
                      {c.title}
                    </Link>
                    {"match" in c && c.match ? (
                      <div className="mt-0.5 text-[14.5px] font-normal text-muted">
                        …{c.match.map((m, i) => (m.bold ? <b key={i} className="font-semibold text-ink">{m.text}</b> : <span key={i}>{m.text}</span>))}…
                      </div>
                    ) : null}
                  </td>
                  <td className="!whitespace-normal">{c.did}</td>
                  <td className="!whitespace-normal text-icon">{c.capabilities.join(", ")}</td>
                  <td className="text-muted">{c.when}</td>
                </tr>
              ))}
            </tbody>
          </Grid>
        ) : null}
      </div>
    </div>
  );
}
