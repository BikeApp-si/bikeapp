"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

// Settings › Instance: checks everything again (the page runs the checks each time it is drawn).
export function RunAgain() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => start(() => router.refresh())}
      className="inline-flex h-9 items-center rounded-[6px] border border-line bg-white px-3.5 text-[15px] font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,.05)] hover:bg-page disabled:opacity-60"
    >
      {pending ? "Checking…" : "Run again"}
    </button>
  );
}
