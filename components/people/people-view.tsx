"use client";

import { SystemIcon } from "@/components/shell/system-icon";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { Calendar, Mail, Network, Plus, Tag, Type, Upload, User, Users, X } from "lucide-react";
import { CHECK, Grid, Head, QUIET_PICKER, ROW, SearchBox, TOOLBAR, UNDER_TOOLBAR } from "@/components/table/table";
import { Avatar, Pill, PersonChip } from "@/components/chips";
import { Button, IconButton } from "@/components/buttons";
import { Picker } from "@/components/picker";
import { TopBar } from "@/components/shell/top-bar";
import { formatDate, tenure } from "@/lib/format";
import { parseDate } from "@/lib/parse";
import { useFormats } from "@/components/formats";
import { cn } from "@/lib/utils";
import { checkNewPerson } from "@/server/kernel/directory-rules";
import { createPerson, importPeople, personRoles, previewPeopleCsv } from "@/app/ws/[ws]/(app)/people/actions";
import type { PersonRow } from "@/server/kernel/directory";
import { Segmented } from "@/components/segmented";
import { OrgChart } from "./org-chart";

type Props = {
  people: (PersonRow & { tint: string })[];
  teams: string[];
  isAdmin: boolean;
  today: string;
  timeZone: string;
  addOpen: boolean;
  chart: boolean; // People › Org chart (M28)
};

const ALL = "__all__";

// 7f: People as a table with search and a team filter; 7g: a person opened in the side panel; Add a person
// and Import CSV for admins.
export function PeopleView({ people, teams, isAdmin, today, timeZone, addOpen, chart }: Props) {
  const fmt = useFormats();
  const [search, setSearch] = useState("");
  const [team, setTeam] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(addOpen && isAdmin);
  const [importing, setImporting] = useState(false);
  const tints = useMemo(() => new Map(people.map((p) => [p.id, p.tint])), [people]);
  const q = search.trim().toLowerCase();
  const shown = people.filter(
    (p) => (!team || p.team === team) && (!q || [p.name, p.email, p.title ?? "", p.team ?? ""].some((v) => v.toLowerCase().includes(q))),
  );
  const person = people.find((p) => p.id === open);

  return (
    <>
      <TopBar title="People" icon={<SystemIcon page="people" />}>
        <Segmented
          items={[
            { label: <><Users size={14} strokeWidth={1.8} />People</>, href: "/people", active: !chart },
            { label: <><Network size={14} strokeWidth={1.8} />Org chart</>, href: "/people?tab=chart", active: chart },
          ]}
        />
        {/* The chart is read only, so its tab has no buttons. */}
        {isAdmin && !chart ? (
          <>
            <Button className="h-8 px-3" onClick={() => setImporting(true)}>
              <Upload size={16} strokeWidth={1.8} className="text-icon" />
              Import CSV
            </Button>
            <Button kind="primary" className="h-8 px-3" onClick={() => setAdding(true)}>
              <Plus size={16} strokeWidth={2} />
              Add a person
            </Button>
          </>
        ) : null}
      </TopBar>
      {chart ? <OrgChart people={people} open={open} onOpen={setOpen} /> : (
      <div className="flex min-h-0 flex-1 flex-col overflow-auto pb-5">
        <div className={TOOLBAR}>
          <SearchBox lead label="Search people" value={search} onChange={setSearch} />
          <Picker
            label="Team"
            className={QUIET_PICKER}
            value={team ?? ALL}
            onChange={(id) => setTeam(id === ALL ? null : id)}
            options={[{ id: ALL, label: "All teams" }, ...teams.map((t) => ({ id: t, label: t }))]}
          />
        </div>
        <div style={UNDER_TOOLBAR}>
          <Grid label="People">
            <thead>
              <tr>
                <th className={CHECK} />
                <Head icon={User}>Name</Head>
                <Head icon={Type}>Job title</Head>
                <Head icon={Tag} className="w-[120px]">Team</Head>
                <Head icon={User} className="w-40">Manager</Head>
                <Head icon={Mail}>Email</Head>
                <Head icon={Calendar} className="w-[120px]">Start date</Head>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} onClick={() => setOpen(p.id)} className={cn("cursor-pointer", ROW, open === p.id && "!bg-primary-light")}>
                  <td className={CHECK} />
                  <td>
                    <PersonChip name={p.name} tint={p.tint} />
                  </td>
                  <td>{p.title ?? ""}</td>
                  <td>{p.team ?? ""}</td>
                  <td>
                    {p.manager ? <PersonChip name={p.manager.name} tint={tints.get(p.manager.id)!} /> : p.noManager ? <Pill tone="yellow" className="text-[13px] font-medium">No manager</Pill> : "—"}
                  </td>
                  <td className="text-muted">{p.email}</td>
                  <td>{p.startDate ? formatDate(p.startDate, fmt) : ""}</td>
                </tr>
              ))}
            </tbody>
          </Grid>
        </div>
      </div>
      )}
      {person ? <PersonPanel person={person} tint={tints.get(person.manager?.id ?? "") ?? ""} today={today} timeZone={timeZone} onClose={() => setOpen(null)} /> : null}
      {adding ? <AddPersonPanel people={people} teams={teams} onClose={() => setAdding(false)} /> : null}
      {importing ? <ImportDialog onClose={() => setImporting(false)} /> : null}
    </>
  );
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

function Side({ label, onClose, children, footer }: { label: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode }) {
  useEscape(onClose);
  return (
    <>
      <div className="absolute inset-0 z-10" onClick={onClose} />
      <aside role="dialog" aria-label={label} className="absolute inset-y-0 right-0 z-20 flex w-[600px] flex-col border-l border-line bg-white">
        {children}
        {footer}
      </aside>
    </>
  );
}

// 7g: avatar, name, title · team; Overview with work email, manager, start date and how long ago, the
// workspace's time zone with the time now, and the roles they hold. Close only.
function PersonPanel({ person, tint, today, timeZone, onClose }: { person: Props["people"][number]; tint: string; today: string; timeZone: string; onClose: () => void }) {
  const fmt = useFormats();
  const [roles, setRoles] = useState<string[] | null>(null);
  useEffect(() => {
    void personRoles(person.id).then((r) => setRoles(r.ok ? r.roles : []));
  }, [person.id]);
  const now = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date()).toLowerCase();
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex min-h-9 items-center gap-3 text-[15px]">
      <span className="w-[132px] shrink-0 text-muted">{label}</span>
      <span className="flex flex-1 flex-wrap items-center gap-2 text-ink">{value}</span>
    </div>
  );
  return (
    <Side label={person.name} onClose={onClose}>
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line pr-3 pl-6">
        <span className="flex-1 text-[15px] font-medium text-ink">People</span>
        <IconButton aria-label="Close" onClick={onClose}>
          <X size={16} strokeWidth={1.8} />
        </IconButton>
      </div>
      <div className="flex items-center gap-3.5 px-5 pt-2 pb-3">
        <Avatar name={person.name} tint={person.tint} size={52} className="text-[26px]" />
        <div className="leading-[1.3]">
          <div className="text-xl font-semibold tracking-[-0.01em]">{person.name}</div>
          <div className="text-[15px] text-muted">{[person.title, person.team].filter(Boolean).join(" · ")}</div>
        </div>
      </div>
      <div className="border-b border-line px-5">
        <span className="inline-block border-b-2 border-primary pb-1.5 text-[15px] font-medium text-ink">Overview</span>
      </div>
      <div className="flex flex-col px-5 py-4">
        {row("Work email", person.email)}
        {row("Manager", person.manager ? <PersonChip name={person.manager.name} tint={tint} large /> : person.noManager ? <Pill tone="yellow" className="text-[13px] font-medium">No manager</Pill> : "—")}
        {row(
          "Start date",
          person.startDate ? (
            <>
              {formatDate(person.startDate, fmt)}
              <span className="text-[13.5px] text-muted">· {tenure(person.startDate, today)}</span>
            </>
          ) : (
            "—"
          ),
        )}
        {row(
          "Time zone",
          <>
            {timeZone}
            <span className="text-[13.5px] text-muted">· {now} now</span>
          </>,
        )}
        {row("Roles", roles === null ? "" : roles.length ? roles.join(" · ") : "—")}
      </div>
    </Side>
  );
}

// Add a person (admins): as 7c, the fields of the team CSV. No email is sent and no roles are given.
function AddPersonPanel({ people, teams, onClose }: { people: Props["people"]; teams: string[]; onClose: () => void }) {
  const [v, setV] = useState({ name: "", email: "", title: "", team: "", managerId: null as string | null, startDate: "" });
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const start = v.startDate.trim() ? parseDate(v.startDate) : null;
  const errors = { ...checkNewPerson({ ...v, startDate: start ?? (v.startDate.trim() ? "bad" : null) }) };
  if (v.startDate.trim() && !start) errors.startDate = "Start date must be a date, like Nov 10, 2026.";

  async function save() {
    setTouched({ name: true, email: true, startDate: true });
    if (Object.keys(errors).length) return;
    setBusy(true);
    const r = await createPerson({ name: v.name, email: v.email, title: v.title, team: v.team, managerId: v.managerId, startDate: start });
    setBusy(false);
    if (!r.ok) return setProblem(r.error);
    onClose();
    router.refresh();
  }

  const input = "h-[34px] flex-1 rounded-[6px] border border-line bg-white px-2.5 text-[15px] shadow-[0_1px_2px_rgba(0,0,0,.04)] outline-none focus:border-primary focus:ring-3 focus:ring-focus placeholder:text-[#90A1B9]";
  const field = (key: keyof typeof v, label: string, required: boolean, el: React.ReactNode) => (
    <div key={key}>
      <div className="flex items-center gap-3">
        <span className="w-[132px] shrink-0 text-[15px] text-muted">
          {label}
          {required ? <span className="text-[#DC2626]"> *</span> : null}
        </span>
        {el}
      </div>
      {touched[key] && errors[key as keyof typeof errors] ? <div className="mt-1 ml-[144px] text-[13.5px] text-[#DC2626]">{errors[key as keyof typeof errors]}</div> : null}
    </div>
  );
  const text = (key: "name" | "email" | "title" | "team" | "startDate", label: string, required = false, placeholder?: string) =>
    field(
      key,
      label,
      required,
      <input
        aria-label={label}
        className={input}
        placeholder={placeholder}
        value={v[key]}
        list={key === "team" ? "teams" : undefined}
        onChange={(e) => setV({ ...v, [key]: e.target.value })}
        onBlur={() => setTouched({ ...touched, [key]: true })}
      />,
    );

  return (
    <Side
      label="Add a person"
      onClose={onClose}
      footer={
        <div className="flex h-12 shrink-0 items-center gap-2 border-t border-line bg-white pr-3 pl-6">
          {problem ? <span className="truncate text-[13.5px] text-[#DC2626]">{problem}</span> : null}
          <span className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="primary" disabled={busy} onClick={() => void save()}>
            Create person
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-0.5 border-b border-line py-3.5 pr-4 pl-5">
        <div className="flex items-center">
          <span className="flex-1 text-[13.5px] text-muted">People</span>
          <IconButton aria-label="Close" onClick={onClose}>
            <X size={16} strokeWidth={1.8} />
          </IconButton>
        </div>
        <span className="text-[18px] font-semibold tracking-[-0.01em]">Add a person</span>
      </div>
      <div className="flex flex-1 flex-col gap-3 overflow-auto px-5 py-4">
        {text("name", "Full name", true)}
        {text("email", "Work email", true)}
        {text("title", "Job title")}
        {text("team", "Team")}
        <datalist id="teams">
          {teams.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        {field(
          "managerId",
          "Manager",
          false,
          <Picker label="Manager" value={v.managerId} onChange={(id) => setV({ ...v, managerId: id })} placeholder="Pick someone" options={people.map((p) => ({ id: p.id, label: p.name, node: <PersonChip name={p.name} tint={p.tint} /> }))} />,
        )}
        {text("startDate", "Start date", false, "Pick a date")}
      </div>
    </Side>
  );
}

// Import CSV: the team CSV (developer notes §4), with a count before anything is saved; all or nothing.
function ImportDialog({ onClose }: { onClose: () => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<{ name: string; text: string; count: number; problems: string[]; flagged: string[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function read(f: File | undefined) {
    if (!f) return;
    const text = await f.text();
    setPicked({ name: f.name, text, ...(await previewPeopleCsv(text)) });
    setProblem(null);
  }
  async function run() {
    if (!picked) return;
    setBusy(true);
    const r = await importPeople(picked.name, picked.text);
    setBusy(false);
    if (!r.ok) return setProblem(r.error);
    onClose();
    router.refresh();
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[rgba(15,23,43,.32)]" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 flex w-[440px] -translate-x-1/2 -translate-y-1/2 flex-col gap-3.5 rounded-[12px] bg-white p-5 shadow-[0_24px_48px_rgba(15,23,43,.2)] outline-none">
          <Dialog.Title className="m-0 text-base font-semibold">Import CSV</Dialog.Title>
          <Dialog.Description className="m-0 text-[15px] leading-[1.55] text-nav">
            Full name, Work email, Job title, Team, Manager email, Start date.
          </Dialog.Description>
          <Button onClick={() => file.current?.click()} className="self-start">
            <Upload size={16} strokeWidth={1.8} className="text-icon" />
            {picked ? picked.name : "Choose a file"}
          </Button>
          <input ref={file} type="file" accept=".csv" hidden onChange={(e) => void read(e.target.files?.[0])} />
          {picked ? (
            <div className="text-[15px] text-nav">
              {picked.count} {picked.count === 1 ? "person" : "people"}
              {picked.problems.map((p) => (
                <div key={p} className="text-[#DC2626]">
                  {p}
                </div>
              ))}
              {picked.flagged.map((p) => (
                <div key={p} className="text-muted">
                  {p}
                </div>
              ))}
            </div>
          ) : null}
          {problem ? <div className="text-[15px] text-[#DC2626]">{problem}</div> : null}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button kind="primary" disabled={!picked || !!picked.problems.length || !picked.count || busy} onClick={() => void run()}>
              Import {picked?.count ? `${picked.count} ${picked.count === 1 ? "person" : "people"}` : ""}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
