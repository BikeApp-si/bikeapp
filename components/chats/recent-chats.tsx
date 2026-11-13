import Link from "next/link";
import { MessageSquare } from "lucide-react";
import type { ChatRow } from "@/server/kernel/chat-list";

// 12a: an admin's recent chats under Do it yourself; All chats opens the list (12b).
export function RecentChats({ chats }: { chats: ChatRow[] }) {
  if (!chats.length) return null;
  return (
    <div className="mx-auto mt-7 flex w-[720px] max-w-full flex-col">
      <div className="flex items-center px-1 pb-1.5">
        <span className="flex-1 text-[15px] font-semibold text-icon">Recent chats</span>
        <Link href="/chats" className="text-[15px] font-medium text-primary-text hover:text-primary-hover">
          All chats
        </Link>
      </div>
      {chats.map((c) => (
        <Link key={c.id} href={c.href} className="flex items-center gap-3 border-b border-fill px-1 py-2.5 hover:bg-page">
          <span className="inline-flex text-muted">
            <MessageSquare size={16} strokeWidth={1.8} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col leading-[1.4]">
            <span className="truncate text-base font-medium">{c.title}</span>
            <span className="truncate text-sm text-muted">{c.line}</span>
          </span>
          <span className="text-sm text-muted">{c.day}</span>
        </Link>
      ))}
    </div>
  );
}
