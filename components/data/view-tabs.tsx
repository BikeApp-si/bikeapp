"use client";

import { useState } from "react";
import { Dialog, Popover } from "radix-ui";
import { ChevronDown, List, Plus, Users } from "lucide-react";
import { Button } from "@/components/buttons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { panel } from "./filter-sort";
import type { SavedView } from "@/server/kernel/saved-views";

// A sheet's saved views behind one picker on the toolbar's left (T1; tabs in M19): "All contracts · 12 ⌄" opens the
// list, "All contracts" first, then the views shared with everyone who sees the sheet (marked), then the person's own.
// The open view's Update, Rename, Share and Delete sit under the list. "Save as view" appears beside the picker when
// the table differs from the open view. The picker's icon is centred 20 px in and its name starts 40 px in, on the
// table's check column and first column.

type Props = {
  allLabel: string; // "All contracts"
  count: number; // the rows the table shows
  views: SavedView[];
  active: string | null;
  dirty: boolean;
  canShare: boolean;
  onOpen: (id: string | null) => void;
  onSave: (name: string, shared: boolean) => Promise<string | null>; // the refusal, if any
  onUpdate: () => Promise<void>;
  onRename: (name: string) => Promise<string | null>;
  onShare: (shared: boolean) => Promise<void>;
  onDelete: () => Promise<void>;
};

export function ViewTabs(p: Props) {
  const view = p.views.find((v) => v.id === p.active) ?? null;
  const mayChange = !!view && (view.mine || (view.shared && p.canShare));
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  return (
    <div className="flex shrink-0 items-center gap-1">
      {renaming && view ? (
        <RenameView view={view} onRename={p.onRename} onDone={() => setRenaming(false)} />
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger aria-label="Views" className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-3 rounded-[6px] px-2 text-[14.5px] font-medium text-ink outline-none hover:bg-active-nav focus-visible:ring-3 focus-visible:ring-focus data-[state=open]:bg-active-nav">
            <List size={16} strokeWidth={1.8} className="shrink-0 text-icon" />
            <span className="inline-flex items-center gap-1.5">
              {view?.shared ? <Users size={13} strokeWidth={1.8} aria-label="Shared" /> : null}
              {view?.name ?? p.allLabel}
              <span className="font-normal text-muted">· {p.count}</span>
              <ChevronDown size={14} strokeWidth={1.8} className="text-muted" />
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[240px]">
            <DropdownMenuRadioGroup value={p.active ?? ""} onValueChange={(id) => p.onOpen(id || null)}>
              <DropdownMenuRadioItem value="">{p.allLabel}</DropdownMenuRadioItem>
              {p.views.map((v) => (
                <DropdownMenuRadioItem key={v.id} value={v.id}>
                  {v.name}
                  {v.shared ? <Users size={13} strokeWidth={1.8} aria-label="Shared" className="ml-auto text-muted" /> : null}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {view && mayChange ? (
              <>
                <DropdownMenuSeparator />
                {p.dirty ? <DropdownMenuItem onSelect={() => void p.onUpdate()}>Update to what’s on screen</DropdownMenuItem> : null}
                <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename</DropdownMenuItem>
                {p.canShare ? <DropdownMenuItem onSelect={() => void p.onShare(!view.shared)}>{view.shared ? "Stop sharing" : "Share with everyone who sees this sheet"}</DropdownMenuItem> : null}
                <DropdownMenuItem className="text-[#DC2626]" onSelect={() => setDeleting(true)}>
                  Delete view
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {p.dirty ? <SaveView canShare={p.canShare} onSave={p.onSave} /> : null}
      {deleting && view ? <DeleteView view={view} onClose={() => setDeleting(false)} onDelete={p.onDelete} /> : null}
    </div>
  );
}

function SaveView({ canShare, onSave }: { canShare: boolean; onSave: Props["onSave"] }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const refused = await onSave(name, shared);
    if (refused) return setError(refused);
    setOpen(false);
    setName("");
    setShared(false);
    setError(null);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-[6px] px-2 text-[14.5px] text-primary-text hover:bg-primary-light">
        <Plus size={14} strokeWidth={1.8} />
        Save as view
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className={cn(panel, "flex w-80 flex-col gap-3 p-3.5")}>
          <label className="flex flex-col gap-1.5 text-[14.5px] font-medium">
            Name
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void save()}
              placeholder="Renewing soon"
              className="h-9 rounded-[6px] border border-line px-2.5 text-[15px] font-normal outline-none focus:border-primary"
            />
          </label>
          {canShare ? (
            <label className="flex items-center gap-2 text-[14.5px]">
              <input type="checkbox" checked={shared} onChange={() => setShared(!shared)} className="size-4 accent-primary" />
              Share with everyone who sees this sheet
            </label>
          ) : null}
          {error ? <span className="text-[13.5px] text-[#DC2626]">{error}</span> : null}
          <div className="flex justify-end gap-2">
            <Button small onClick={() => setOpen(false)}>Cancel</Button>
            <Button small kind="primary" onClick={() => void save()}>Save view</Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function RenameView({ view, onRename, onDone }: { view: SavedView; onRename: Props["onRename"]; onDone: () => void }) {
  const [name, setName] = useState(view.name);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-1">
      <input
        autoFocus
        aria-label="View name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={onDone}
        onKeyDown={async (e) => {
          if (e.key === "Escape") return onDone();
          if (e.key !== "Enter") return;
          const refused = await onRename(name);
          if (refused) return setError(refused);
          onDone();
        }}
        className="h-7 w-40 rounded-[6px] border border-line px-2 text-[14.5px] outline-none focus:border-primary"
      />
      {error ? <span className="text-[13px] text-[#DC2626]">{error}</span> : null}
    </span>
  );
}

function DeleteView({ view, onClose, onDelete }: { view: SavedView; onClose: () => void; onDelete: Props["onDelete"] }) {
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[rgba(15,23,43,.32)]" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 flex w-[420px] -translate-x-1/2 -translate-y-1/2 flex-col gap-3.5 rounded-[12px] bg-white p-5 shadow-[0_24px_48px_rgba(15,23,43,.2)] outline-none">
          <Dialog.Title className="m-0 text-base font-semibold">Delete the view “{view.name}”?</Dialog.Title>
          <Dialog.Description className="m-0 text-[15px] leading-[1.55] text-nav">
            {view.shared ? "It goes for everyone it was shared with. " : ""}The rows stay as they are.
          </Dialog.Description>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button kind="danger" onClick={() => (onClose(), void onDelete())}>
              Delete view
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
