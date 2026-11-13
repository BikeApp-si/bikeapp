"use client";

import { Search, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// M33 (m33-f): the search box in Chats' top bar. What's typed goes in the address (?q=), and the page searches the
// admin's own chats on the server.
export function ChatSearch({ initial }: { initial: string }) {
  const router = useRouter();
  const path = usePathname();
  const [q, setQ] = useState(initial);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    const t = setTimeout(() => router.replace(q.trim() ? `${path}?q=${encodeURIComponent(q.trim())}` : path), 250);
    return () => clearTimeout(t);
  }, [q, path, router]);
  return (
    <label className="flex h-9 w-[320px] items-center gap-2 rounded-[8px] border border-line bg-white px-3 text-[15px] text-ink shadow-[0_1px_2px_rgba(0,0,0,.05)] focus-within:border-primary focus-within:ring-3 focus-within:ring-focus">
      <Search size={16} strokeWidth={1.8} className="shrink-0 text-icon" />
      <input aria-label="Search chats" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted" />
      {q ? (
        <button type="button" aria-label="Clear the search" onClick={() => setQ("")} className="inline-flex cursor-pointer text-muted hover:text-ink">
          <X size={14} strokeWidth={2} />
        </button>
      ) : null}
    </label>
  );
}
