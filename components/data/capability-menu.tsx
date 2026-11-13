"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Dialog } from "radix-ui";
import { Download, Ellipsis, Trash2 } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/buttons";
import { firstName } from "@/lib/greeting";
import { capabilityImpact, removeCapability } from "@/app/ws/[ws]/(app)/c/[cap]/actions";

type Impact = {
  name: string;
  sheets: { name: string; row: { one: string; many: string }; count: number }[];
  files: number;
  loseAccess: string[] | "everyone";
  connections: { direction: "into" | "out"; capability: string; text: string }[];
  refused: string | null; // another capability links to it, so it can't be deleted (X7)
};

const list = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

// The ⋯ menu (9c), admins only: Export data as CSV, and Delete with its typed-name check (9d, X7).
export function CapabilityMenu({ capId, name, sheetCount }: { capId: string; name: string; sheetCount: number }) {
  const [impact, setImpact] = useState<Impact | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const exportHref = `/c/${capId}/export`;

  async function askDelete() {
    const r = await capabilityImpact(capId);
    if (!r.ok) return setError(r.error);
    setTyped("");
    setError(null);
    setImpact(r);
  }

  async function confirm() {
    setBusy(true);
    const r = await removeCapability(capId, typed);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    router.push(r.next);
    router.refresh();
  }

  const counts = impact
    ? [...impact.sheets.map((s) => `${s.count} ${s.count === 1 ? s.row.one : s.row.many}`), `${impact.files} ${impact.files === 1 ? "file" : "files"}`]
    : [];
  // The capabilities on the other end of a connection (not People), which keep their rows (X7).
  const others = [...new Set((impact?.connections ?? []).map((c) => c.capability).filter((n) => n && n !== "People"))];
  const losing = impact?.loseAccess === "everyone" ? "Everyone loses access." : impact?.loseAccess.length ? `${list(impact.loseAccess.map(firstName))} lose${impact.loseAccess.length === 1 ? "s" : ""} access.` : "";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="More"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-[6px] text-icon outline-none hover:bg-active-nav focus-visible:ring-3 focus-visible:ring-focus data-[state=open]:bg-active-nav"
        >
          <Ellipsis size={16} strokeWidth={1.8} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} className="w-[290px] rounded-[10px] border-line p-1.5 shadow-[0_10px_30px_rgba(15,23,43,.12)]">
          <DropdownMenuItem asChild className="items-start gap-2.5 rounded-[6px] px-2.5 py-2 focus:bg-fill">
            <a href={exportHref} download>
              <Download size={16} strokeWidth={1.8} className="mt-0.5 text-ink" />
              <span className="flex flex-col leading-[1.4]">
                <span className="text-[15.5px] font-medium text-ink">Export data as CSV</span>
                <span className="text-sm text-muted">
                  {sheetCount === 1 ? "One file" : `All ${sheetCount} sheets, one file each`}, to keep or to build a new app from
                </span>
              </span>
            </a>
          </DropdownMenuItem>
          <DropdownMenuSeparator className="mx-1 my-1.5" />
          <DropdownMenuItem onSelect={() => void askDelete()} className="items-start gap-2.5 rounded-[6px] px-2.5 py-2 focus:bg-fill">
            <Trash2 size={16} strokeWidth={1.8} className="mt-0.5 text-[#E7000B]" />
            <span className="flex flex-col leading-[1.4]">
              <span className="text-[15.5px] font-medium text-[#E7000B]">Delete {name}</span>
              <span className="text-sm text-muted">Removes it and its data for everyone</span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {impact ? (
        <Dialog.Root open onOpenChange={(o) => !o && setImpact(null)}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-[rgba(15,23,43,.45)]" />
            <Dialog.Content className="fixed top-[170px] left-1/2 z-50 flex max-h-[calc(100vh-200px)] w-[480px] -translate-x-1/2 flex-col gap-3.5 overflow-auto rounded-[12px] border border-line bg-white p-6 shadow-[0_20px_50px_rgba(15,23,43,.25)] outline-none">
              <Dialog.Title className="m-0 text-lg font-semibold">Delete {impact.name}?</Dialog.Title>
              <Dialog.Description className="m-0 text-base leading-[1.6] text-nav">
                This removes it for everyone: {counts.join(", ")}. {losing ? `${losing} ` : ""}The Audit log keeps a record of it. You can’t undo this.
              </Dialog.Description>
              <p className="m-0 text-[15.5px] leading-[1.55] text-muted">
                To change how it works instead, change it in Customize; your data moves with it. To keep the data, or build a new app from it, export it as CSV first.
              </p>
              {impact.connections.length ? (
                <div className="flex flex-col gap-1.5 text-[15.5px]">
                  <b className="font-semibold">Connections that will be removed</b>
                  <table className="mt-0.5 mb-1 w-full border-collapse">
                    <thead>
                      <tr>
                        <th className="w-[70px] border-b border-[#CAD5E2] py-2 pr-3 text-left text-[15px] font-semibold" />
                        <th className="border-b border-[#CAD5E2] py-2 pr-3 text-left text-[15px] font-semibold">Connection</th>
                      </tr>
                    </thead>
                    <tbody>
                      {impact.connections.map((c, i) => (
                        <tr key={i}>
                          <td className="border-b border-line py-2 pr-3 align-top">{c.direction === "into" ? "Into" : "Out of"}</td>
                          <td className="border-b border-line py-2 pr-3 align-top">{c.text}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {others.length ? <p className="m-0 text-[15px] text-muted">{others.length > 1 ? `${others.slice(0, -1).join(", ")} and ${others.at(-1)}` : others[0]} {others.length > 1 ? "keep their" : "keeps its"} own rows; only these hand-offs stop.</p> : null}
                </div>
              ) : null}
              {impact.refused ? (
                <p className="m-0 text-base leading-[1.6] font-medium text-ink">{impact.refused}</p>
              ) : (
                <label className="flex flex-col gap-1.5">
                  <span className="text-[15px] font-medium">
                    Type <b className="font-semibold">{impact.name}</b> to confirm
                  </span>
                  <input
                    autoFocus
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    className="h-9 rounded-[6px] border border-line px-3 text-base outline-none focus:border-primary focus:ring-3 focus:ring-focus"
                  />
                </label>
              )}
              {error ? <span className="text-[15px] text-[#DC2626]">{error}</span> : null}
              <div className="flex gap-2 pt-1">
                <a href={exportHref} download className="inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] border border-line bg-white px-3.5 text-[15px] font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,.05)] hover:bg-page">
                  <Download size={16} strokeWidth={1.8} className="text-icon" />
                  Export as CSV
                </a>
                <span className="flex-1" />
                <Button onClick={() => setImpact(null)}>Cancel</Button>
                {impact.refused ? null : (
                  <Button kind="danger" className="bg-[#E7000B] px-4" disabled={busy || typed.trim() !== impact.name} onClick={() => void confirm()}>
                    Delete {impact.name}
                  </Button>
                )}
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </>
  );
}
