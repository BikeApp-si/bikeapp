"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Avatar, PersonChip } from "@/components/chips";
import { Button } from "@/components/buttons";
import { Picker } from "@/components/picker";
import { changeLogo, changeSettings, makeAdmin, renameCompany, unmakeAdmin } from "@/app/ws/[ws]/(app)/settings/actions";
import type { SettingsChange } from "@/server/kernel/settings";
import { COLUMN, LABEL, LAST_ROW, ROW } from "./rows";

type Choice = { id: string; label: string };
export type CompanyDetails = {
  website: string;
  street: string;
  city: string;
  addressRegion: string;
  country: string | null;
  currency: string;
  numberGrouping: "standard" | "indian";
  dateStyle: "mdy" | "dmy";
  fiscalYearStart: number;
};
type Props = {
  name: string;
  logoUploadId: string | null;
  details: CompanyDetails;
  countries: Choice[];
  currencies: Choice[];
  admins: { id: string; name: string; title: string | null; owner: boolean; tint: string }[];
  people: { id: string; name: string; tint: string }[];
};

const row = ROW;
const label = LABEL;

const INPUT =
  "h-[34px] w-[280px] rounded-[6px] border border-line px-2.5 text-[15.5px] shadow-[0_1px_2px_rgba(0,0,0,.04)] outline-none focus:border-primary focus:ring-3 focus:ring-focus";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const YEARS: Choice[] = MONTHS.map((m, i) => ({ id: String(i + 1), label: `${m} to ${MONTHS[(i + 11) % 12]}` }));
const NUMBERS: Choice[] = [
  { id: "standard", label: "1,234,567" },
  { id: "indian", label: "12,34,567" },
];
const DATES: Choice[] = [
  { id: "mdy", label: "Nov 14, 2026" },
  { id: "dmy", label: "14 Nov 2026" },
];

// A text field saved when it's left (Enter leaves it).
function TextRow({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  return (
    <div className={ROW}>
      <span className="flex-1 text-base font-medium">{label}</span>
      <input aria-label={label} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v.trim() !== value && onSave(v)} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} className={INPUT} />
    </div>
  );
}

function PickRow({ label, value, options, onPick, last, note }: { label: string; value: string | null; options: Choice[]; onPick: (id: string) => void; last?: boolean; note?: string }) {
  return (
    <div className={last ? LAST_ROW : ROW}>
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="text-base font-medium">{label}</span>
        {note ? <span className="text-[15px] leading-[1.5] text-muted">{note}</span> : null}
      </div>
      <div className="w-[280px]">
        <Picker label={label} value={value} options={options} onChange={(id) => id && id !== value && onPick(id)} />
      </div>
    </div>
  );
}

// 9b, fuller in M26: the company (logo, name, website, address), how it writes money, numbers and dates, and the admins.
export function SettingsForm({ name, logoUploadId, details: d, countries, currencies, admins, people }: Props) {
  const router = useRouter();
  const [value, setValue] = useState(name);
  const [problem, setProblem] = useState<string | null>(null);
  const logo = useRef<HTMLInputElement>(null);
  const done = (r: { ok: boolean; error?: string }) => (r.ok ? (setProblem(null), router.refresh()) : setProblem(r.error ?? null));
  const save = async (change: Omit<SettingsChange, "logoUploadId">) => done(await changeSettings(change));

  async function upload(file: File | undefined) {
    if (!file) return;
    const form = new FormData();
    form.set("file", file);
    done(await changeLogo(form));
  }

  const others = people.filter((p) => !admins.some((a) => a.id === p.id));
  return (
    <div className={COLUMN}>
      <div className={label}>Company</div>
      <div className={row}>
        <span className="flex-1 text-base font-medium">Logo</span>
        {logoUploadId ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/files/${logoUploadId}`} alt="Logo" className="size-8 rounded-[8px] object-cover" />
        ) : (
          <span className="inline-flex size-8 items-center justify-center rounded-[8px] bg-ink text-base text-white">{name.trim().charAt(0).toUpperCase()}</span>
        )}
        <Button onClick={() => logo.current?.click()}>Change</Button>
        <input ref={logo} type="file" accept=".png,.jpg,.jpeg" hidden onChange={(e) => void upload(e.target.files?.[0])} />
      </div>
      <div className={row}>
        <span className="flex-1 text-base font-medium">Name</span>
        <input
          aria-label="Name"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={async () => value.trim() !== name && done(await renameCompany(value))}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className={INPUT}
        />
      </div>
      <TextRow label="Website" value={d.website} onSave={(website) => save({ website })} />
      <TextRow label="Street" value={d.street} onSave={(street) => save({ street })} />
      <TextRow label="City" value={d.city} onSave={(city) => save({ city })} />
      <TextRow label="State or region" value={d.addressRegion} onSave={(addressRegion) => save({ addressRegion })} />
      <PickRow label="Country" value={d.country} options={countries} onPick={(country) => save({ country })} last />
      <div className={label}>Money and dates</div>
      <PickRow label="Currency" note="Amounts aren't converted." value={d.currency} options={currencies} onPick={(currency) => save({ currency })} />
      <PickRow label="Numbers" value={d.numberGrouping} options={NUMBERS} onPick={(g) => save({ numberGrouping: g as CompanyDetails["numberGrouping"] })} />
      <PickRow label="Dates" value={d.dateStyle} options={DATES} onPick={(s) => save({ dateStyle: s as CompanyDetails["dateStyle"] })} />
      <PickRow label="Financial year" value={String(d.fiscalYearStart)} options={YEARS} onPick={(m) => save({ fiscalYearStart: Number(m) })} last />
      <div className={label}>
        Admins
        <Picker
          label="Add an admin"
          value={null}
          onChange={async (id) => id && done(await makeAdmin(id))}
          options={others.map((p) => ({ id: p.id, label: p.name, node: <PersonChip name={p.name} tint={p.tint} /> }))}
          trigger={
            <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-[6px] border border-line bg-white px-3.5 text-[15px] font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,.05)] hover:bg-page">
              <Plus size={16} strokeWidth={1.8} className="text-icon" />
              Add an admin
            </button>
          }
        />
      </div>
      {admins.map((a, i) => (
        <div key={a.id} className={i === admins.length - 1 ? row.replace("border-b border-fill ", "") : row}>
          <Avatar name={a.name} tint={a.tint} size={24} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-base font-medium">{a.name}</span>
            {a.title ? <span className="text-[15px] leading-[1.5] text-muted">{a.title}</span> : null}
          </div>
          {a.owner ? (
            <span className="text-[15px] text-muted">Owner</span>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-line bg-white pr-2 pl-2.5 text-[15px] shadow-[0_1px_2px_rgba(0,0,0,.05)] outline-none">
                Admin
                <ChevronDown size={14} strokeWidth={1.8} className="text-muted" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="rounded-[8px] border-line p-1">
                <DropdownMenuItem className="h-8 rounded-[6px] px-2.5 text-[15px] text-[#DC2626]" onSelect={async () => done(await unmakeAdmin(a.id))}>
                  Remove admin
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      ))}
      {problem ? <div className="pt-2 text-[15px] text-[#DC2626]">{problem}</div> : null}
    </div>
  );
}
