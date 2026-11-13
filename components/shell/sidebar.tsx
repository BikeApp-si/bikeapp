"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStartNavigation } from "./navigation";
import { BookOpen, ExternalLink, LogOut, Plus } from "lucide-react";
import { SystemIcon } from "./system-icon";
import { OPEN_COMMANDS } from "./command-bar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { SIDEBAR_ACTIVE, SIDEBAR_BG, SIDEBAR_HOVER, TOP_BAR_BG } from "@/lib/chrome";

export type SidebarProps = {
  workspaceName: string;
  logoUploadId: string | null;
  peopleCount: number;
  person: { name: string; email: string; title: string | null; isAdmin: boolean };
  // The capabilities this person can see, in sidebar order, with their icons drawn on the server and how many
  // rows wait on them (the bubble).
  capabilities: { id: string; name: string; icon: React.ReactNode; waiting: number }[];
  // M31: the Inbox's bubble, everything that waits on them (its To do).
  toDo: number;
  // P1: the company's AI credits this month, for admins only (null for everyone else).
  credits?: { left: number; total: number } | null;
  logOut: () => Promise<{ next: string }>;
  // E1: bikeapp.si/docs, opened in a new tab from the foot of Workspace, for everyone (null: no link).
  docsUrl: string | null;
};

function NavItem({ href, icon, label, count, bubble, plain }: { href: string; icon: React.ReactNode; label: string; count?: number; bubble?: number; plain?: boolean }) {
  const path = usePathname();
  const startNavigation = useStartNavigation();
  const active = !plain && (path === href || path.startsWith(`${href}/`));
  return (
    <Link
      href={href}
      onClick={(e) => {
        // A plain click opens the page here: the panel shows the loading screen until it arrives.
        if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) startNavigation(href);
      }}
      className={cn(
        "flex h-9 items-center gap-2 rounded-[8px] px-2.5 text-[14.5px]",
        active ? cn(SIDEBAR_ACTIVE, "font-medium text-ink") : cn("text-nav", SIDEBAR_HOVER),
      )}
    >
      <span className="inline-flex text-icon">{icon}</span>
      <span className="flex-1">{label}</span>
      {count !== undefined ? <span className="text-muted">{count}</span> : null}
      {bubble ? (
        <span aria-label={`${bubble} waiting on you`} className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-[5px] text-[12px] font-semibold text-white">
          {bubble}
        </span>
      ) : null}
    </Link>
  );
}

// A group's label takes a 36 px slot, its words at the foot, so the sidebar keeps the table's 36 px rows (T1).
const Section = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-9 items-end px-2 pb-2 text-[12.5px] font-medium text-muted">{children}</div>
);

// Home; Inbox (M31); Chats (admins); Capabilities (+ Add capability for admins); Workspace: People, and for admins Audit log, Ontology, Settings.
export function Sidebar({ workspaceName, logoUploadId, peopleCount, person, capabilities, toDo, credits, logOut, docsUrl }: SidebarProps) {
  const admin = person.isAdmin;
  return (
    // As tall as the window: the list scrolls on its own, the name and Log out stay at the bottom.
    // The top block is as tall as the top bar, so its line and the top bar's are one (T1); items then start 8 px
    // under it, on the same 36 px lines as the table's rows.
    <aside className={cn("flex h-full w-[236px] shrink-0 flex-col px-2.5 pb-3", SIDEBAR_BG)}>
      <div className={cn("-mx-2.5 mb-2 flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-[18px]", TOP_BAR_BG)}>
        {logoUploadId ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/files/${logoUploadId}`} alt="" className="size-8 rounded-[8px] object-cover" />
        ) : (
          <span className="inline-flex size-8 items-center justify-center rounded-[8px] bg-ink text-[15px] text-white">
            {workspaceName.trim().charAt(0).toUpperCase()}
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[15px] font-semibold text-ink">{workspaceName}</span>
          <span className="text-[12.5px] text-muted">Bike · {peopleCount} {peopleCount === 1 ? "person" : "people"}</span>
        </span>
        {credits ? <CreditsRing left={credits.left} total={credits.total} /> : null}
      </div>

      <nav className="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto px-1 *:shrink-0">
        {/* ⌘K (0.4), for people who don't know the keys. */}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event(OPEN_COMMANDS))}
          className={cn("flex h-9 cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 text-left text-[14.5px] text-nav", SIDEBAR_HOVER)}
        >
          <SystemIcon page="search" />
          <span className="flex-1">Search</span>
          <kbd className="text-[12px] text-muted">⌘K</kbd>
        </button>
        <NavItem href="/home" icon={<SystemIcon page="home" />} label="Home" />
        <NavItem href="/inbox" icon={<SystemIcon page="inbox" />} label="Inbox" bubble={toDo} />
        {admin ? <NavItem href="/chats" icon={<SystemIcon page="chats" />} label="Chats" /> : null}
        {admin ? <NavItem href="/reports" icon={<SystemIcon page="reports" />} label="Reports" /> : null}

        <Section>Apps</Section>
        {capabilities.map((c) => (
          <NavItem key={c.id} href={`/c/${c.id}`} icon={c.icon} label={c.name} bubble={c.waiting} />
        ))}
        {admin ? <NavItem href="/home" icon={<Plus size={16} strokeWidth={1.8} />} label="Add app" plain /> : null}

        <Section>Workspace</Section>
        <NavItem href="/people" icon={<SystemIcon page="people" />} label="People" count={peopleCount} />
        {admin ? (
          <>
            <NavItem href="/audit" icon={<SystemIcon page="audit" />} label="Audit log" />
            <NavItem href="/ontology" icon={<SystemIcon page="ontology" />} label="Ontology" />
            <NavItem href="/settings" icon={<SystemIcon page="settings" />} label="Settings" />
          </>
        ) : null}
        {docsUrl ? (
          <a href={docsUrl} target="_blank" rel="noopener" className={cn("flex h-9 items-center gap-2 rounded-[8px] px-2.5 text-[14.5px] text-nav", SIDEBAR_HOVER)}>
            <span className="inline-flex text-icon">
              <BookOpen size={16} strokeWidth={1.8} />
            </span>
            <span className="flex-1">Docs</span>
            <ExternalLink size={13} strokeWidth={1.8} className="text-muted" aria-hidden />
          </a>
        ) : null}
      </nav>

      {/* The name and role open a menu above them: email, then Log out (developer notes §1). */}
      {/* A full-width line above the name and Log out, like the one at the top (P1). */}
      <div aria-hidden className="-mx-2.5 mt-2 shrink-0 border-t border-line" />
      <DropdownMenu>
        <DropdownMenuTrigger className="mt-1.5 flex shrink-0 items-center gap-2.5 rounded-[8px] p-2 text-left outline-none hover:bg-[#EAEFF7] focus-visible:ring-2 focus-visible:ring-focus data-[state=open]:bg-[#EAEFF7]">
          <span className="inline-flex size-8 items-center justify-center rounded-[8px] bg-line text-[15px] font-medium text-ink">
            {person.name.trim().charAt(0).toUpperCase()}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[14.5px] font-medium text-ink">{person.name}</span>
            <span className="truncate text-[12.5px] text-muted">{[person.title, admin ? "Admin" : null].filter(Boolean).join(" · ")}</span>
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" sideOffset={4} className="w-(--radix-dropdown-menu-trigger-width) rounded-[8px] border-line p-1">
          <DropdownMenuLabel className="truncate px-2.5 py-1.5 text-[12.5px] font-normal text-muted">{person.email}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="h-9 gap-2 rounded-[6px] px-2.5 text-[14.5px] text-nav"
            onSelect={async () => window.location.assign((await logOut()).next)}
          >
            <LogOut size={16} strokeWidth={1.8} className="text-icon" />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </aside>
  );
}

// Right of the company's name, for admins (Nov 6, in place of P1's row at the foot): a ring of the credits remaining
// this month with "AI" in its middle, red under a tenth. Only its square is a link, to the AI credits page.
function CreditsRing({ left, total }: { left: number; total: number }) {
  const path = usePathname();
  const active = path === "/credits" || path.startsWith("/credits/");
  const share = total ? Math.max(0, Math.min(1, left / total)) : 0;
  const r = 10.5;
  const around = 2 * Math.PI * r;
  return (
    <Link
      href="/credits"
      aria-label={`AI credits: ${left.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} remaining this month`}
      className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-[8px] outline-none focus-visible:ring-2 focus-visible:ring-focus", active ? SIDEBAR_ACTIVE : SIDEBAR_HOVER)}
    >
      <svg aria-hidden width="24" height="24" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r={r} fill="none" stroke="#E3E6EA" strokeWidth="2.5" />
        {share > 0 ? (
          <circle
            cx="12"
            cy="12"
            r={r}
            fill="none"
            stroke={share < 0.1 ? "#DC2626" : "#1E90FF"}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={`${share * around} ${around}`}
            transform="rotate(-90 12 12)"
          />
        ) : null}
        <text x="12" y="12" textAnchor="middle" dominantBaseline="central" fontSize="10" fontWeight="600" fill="#0F172B">
          AI
        </text>
      </svg>
    </Link>
  );
}
