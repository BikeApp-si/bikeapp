import { formatDay, US, type Formats } from "@/lib/format";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { capabilities as capabilitiesTable, capabilityVersions, ontologies, ontologyVersions, people as peopleTable, rows, workspaces } from "@/db/schema";
import { mustBeAdmin } from "./admin";
import { record } from "./audit";
import { capabilitiesFor } from "./capabilities";
import { currentTime } from "./clock";
import { load, type KernelCtx } from "./context";
import { listHolidays } from "./holidays";
import { renderCapabilityText } from "./render-text";
import type { CapabilityFile } from "./schema/file";
import { worthALook, type CoherenceItem } from "./coherence";
import { isEmptyValue } from "./values";
import type { Tx } from "./tx";

// The Ontology (4e), the kernel's side. What prompt 6 may write from (each capability's Customize text, the
// connections between capabilities and counts, all read with the asking admin's access), the check of what
// it wrote, the stored versions (every one kept since M34), and the page's breakdown, which the kernel builds with no AI: every
// connection, each capability in a sentence with its counts and owner. Where prompt 6 wrote nothing (or its
// answer didn't pass), the breakdown reads from the files.

export type OntologyCapability = {
  id: string;
  name: string;
  icon: string;
  version: number;
  text: string; // its Customize text, as the kernel renders it
  sheets: number;
  steps: string; // "3 steps", "2 step flows", "" with none
  owner: string | null; // first name
  rows: number;
};
export type OntologyConnection = { key: string; from: string; to: string; reading: string };
export type OntologyInput = {
  company: { name: string; whatItDoes: string | null; people: number; teams: number };
  capabilities: OntologyCapability[];
  connections: OntologyConnection[];
  stats: {
    rules: number;
    withoutManager: string[]; // people whose manager isn't in People
    holidays: { count: number; pages: number[] };
    gaps: { capability: string; sheet: string; column: string; empty: number }[]; // required or choice columns some rows left empty
  };
  // The company's rules (0.2), each with where it applies; left out while there are none, so a company without
  // any reads exactly as before.
  companyRules?: { text: string; appliesTo: string[] }[];
};
export type OntologyWritten = {
  intro: string;
  paragraphs: string[];
  sentences: Record<string, string>; // capability name → sentence
  phrases: Record<string, string>; // connection key → phrase
  worth: string[];
};
export type StoredOntology = { version: number; inputHash: string; written: OntologyWritten; writtenAt: Date };
// An app as a version of the Ontology read it: by id, its name then, and its file version.
export type OntologyRead = { id: string; name: string; version: number };

export const readOf = (input: OntologyInput): OntologyRead[] => input.capabilities.map((c) => ({ id: c.id, name: c.name, version: c.version }));

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function stepsOf(file: CapabilityFile): string {
  const flows = file.sheets.filter((s) => s.steps?.length);
  if (!flows.length) return "";
  return flows.length === 1 ? plural(flows[0]!.steps!.length, "step") : `${flows.length} step flows`;
}

// Where one capability starts or moves rows in another (a rule), or adds up another's rows (a total).
export function connectionsOf(order: string[], files: ReadonlyMap<string, CapabilityFile>): OntologyConnection[] {
  const out = new Map<string, OntologyConnection>();
  const add = (from: string, to: string, reading: string) => {
    const a = files.get(from)?.name;
    const b = files.get(to)?.name;
    // By name: the key goes to prompt 6, which never sees ids, and stays the same from one run to the next.
    const key = `${a} > ${b}`;
    if (a && b && from !== to && !out.has(key)) out.set(key, { key, from: a, to: b, reading });
  };
  for (const id of order) {
    const file = files.get(id)!;
    for (const rule of file.rules)
      for (const a of rule.actions)
        if ((a.kind === "create_row_in" || a.kind === "update_row_in") && a.target.capability && a.target.capability !== id)
          add(id, a.target.capability, `${lowerFirst(rule.reading.when)}, ${lowerFirst(rule.reading.then)}`);
    for (const s of file.sheets)
      for (const c of s.columns) {
        const sum = c.expr && typeof c.expr === "object" && "sumOf" in c.expr ? c.expr.sumOf : undefined;
        if (sum?.capability && sum.capability !== id) add(sum.capability, id, `${file.name} adds them up in ${c.name}`);
      }
  }
  return [...out.values()];
}

// What prompt 6 writes from, as the admin sees it.
export async function ontologyInput(tx: Tx, ctx: KernelCtx): Promise<OntologyInput> {
  await mustBeAdmin(tx, ctx);
  const loaded = await load(tx);
  const visible = await capabilitiesFor(tx, ctx);
  const files = new Map(visible.map((c) => [c.id, loaded.files.get(c.id)!.file]));
  const personName = (id: string) => loaded.people.get(id)?.name;
  const all = await tx.select({ team: peopleTable.team, name: peopleTable.name, managerFlag: peopleTable.managerFlag }).from(peopleTable);

  const capabilities: OntologyCapability[] = [];
  const gaps: OntologyInput["stats"]["gaps"] = [];
  for (const c of visible) {
    const file = files.get(c.id)!;
    // The Customize text, plus the columns each sheet works out (it leaves them out), so prompts 4 and 6 don't
    // read a rule's computed column as one that isn't there.
    const worksOut = file.sheets.flatMap((s) => {
      const names = s.columns.filter((x) => x.type === "computed").map((x) => x.name);
      return names.length ? [`${s.name} sheet works out: ${names.join(", ")}.`] : [];
    });
    const text = [
      ...renderCapabilityText(file, { capId: c.id, files, personName, viewerId: null, withoutForm: true, formats: loaded.formats })
        .filter((s) => !s.muted)
        .map((s) => `${s.heading}: ${s.lines.join(" ")}`),
      ...worksOut,
    ].join("\n");
    const live = await tx.select({ sheetId: rows.sheetId, data: rows.data }).from(rows).where(and(eq(rows.capabilityId, c.id), isNull(rows.deletedAt)));
    for (const s of file.sheets) {
      const mine = live.filter((r) => r.sheetId === s.id);
      for (const col of s.columns.filter((x) => x.required || x.type === "choice")) {
        // A gap is a column some rows have and others don't; one empty on every row is one nothing has filled
        // yet (an export that never had it), not missing data.
        const empty = mine.filter((r) => isEmptyValue((r.data as Record<string, unknown>)[col.id])).length;
        if (empty && empty < mine.length) gaps.push({ capability: file.name, sheet: s.name, column: col.name, empty });
      }
    }
    const owner = loaded.files.get(c.id)!.ownerId;
    capabilities.push({
      id: c.id,
      name: file.name,
      icon: file.icon,
      version: loaded.files.get(c.id)!.version,
      text,
      sheets: file.sheets.length,
      steps: stepsOf(file),
      owner: owner ? (personName(owner)?.split(" ")[0] ?? null) : null,
      rows: live.length,
    });
  }
  const holidays = await listHolidays(tx);
  const [ws] = await tx.select({ name: workspaces.name, whatItDoes: workspaces.whatItDoes }).from(workspaces);
  const companyRules = (loaded.company?.rules ?? []).map((r) => ({
    text: r.text,
    appliesTo: r.applications.filter((a) => files.has(a.capabilityId)).map((a) => `${files.get(a.capabilityId)!.name} · ${files.get(a.capabilityId)!.sheets.find((s) => s.id === a.trigger.sheet)?.name ?? ""}`),
  }));
  return {
    ...(companyRules.length ? { companyRules } : {}),
    company: { name: ws?.name ?? "", whatItDoes: ws?.whatItDoes ?? null, people: all.length, teams: new Set(all.map((p) => p.team).filter(Boolean)).size },
    capabilities,
    connections: connectionsOf(
      visible.map((c) => c.id),
      files,
    ),
    stats: {
      rules: [...files.values()].reduce((n, f) => n + f.rules.length, 0),
      withoutManager: all.filter((p) => p.managerFlag).map((p) => p.name).sort(), // the same order every time
      holidays: { count: holidays.length, pages: [...new Set(holidays.map((h) => h.page).filter((n): n is number => n !== null))].sort((a, b) => a - b) },
      gaps,
    },
  };
}

export const hashOf = (input: OntologyInput) => createHash("sha256").update(JSON.stringify(input)).digest("hex");

// The check of prompt 6's answer: a sentence for each capability and a phrase for each connection, by their
// names, and no number that isn't in what it was given (no invented count, amount or threshold).
export function checkOntology(w: OntologyWritten, input: OntologyInput): string[] {
  const problems: string[] = [];
  const names = new Set(input.capabilities.map((c) => c.name));
  for (const n of names) if (!w.sentences[n]?.trim()) problems.push(`Write one sentence for ${n}.`);
  for (const n of Object.keys(w.sentences)) if (!names.has(n)) problems.push(`"${n}" isn't an app; sentences are for ${[...names].join(", ")}.`);
  const keys = new Set(input.connections.map((c) => c.key));
  for (const k of Object.keys(w.phrases)) if (!keys.has(k)) problems.push(`"${k}" isn't one of the connections.`);
  if (w.worth.length > 3) problems.push("At most 3 worth a look items.");
  const given = new Set((JSON.stringify(input).match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, "")));
  const said = [w.intro, ...w.paragraphs, ...Object.values(w.sentences), ...Object.values(w.phrases), ...w.worth].join(" ");
  for (const n of new Set((said.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((x) => x.replace(/,/g, ""))))
    if (!given.has(n)) problems.push(`${n} isn't a number in the app texts or the counts; use only those.`);
  return problems;
}

export async function readOntology(tx: Tx): Promise<StoredOntology | null> {
  const [o] = await tx.select().from(ontologies);
  return o ? { version: o.version, inputHash: o.inputHash, written: o.written as OntologyWritten, writtenAt: o.writtenAt } : null;
}

// The new current version, kept among the versions with the app versions it read, and its Audit entry.
export async function saveOntology(tx: Tx, ctx: KernelCtx, inputHash: string, written: OntologyWritten, read: OntologyRead[]): Promise<number> {
  await mustBeAdmin(tx, ctx);
  const at = ctx.now ?? currentTime();
  const before = await readOntology(tx);
  const version = (before?.version ?? 0) + 1;
  const values = { workspaceId: ctx.workspaceId, version, inputHash, written, writtenAt: at, writtenBy: ctx.actor.id };
  if (before) await tx.update(ontologies).set(values).where(eq(ontologies.workspaceId, ctx.workspaceId));
  else await tx.insert(ontologies).values(values);
  await tx.insert(ontologyVersions).values({ ...values, read });
  await record(tx, ctx, { who: ctx.actor.email, event: "ontology.written", details: { version }, at });
  return version;
}

// ── Versions (M34) ──

export type OntologyVersionItem = { version: number; writtenAt: Date; apps: number; what: string };

const listOf = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? ""));

// What a version was written after, in fixed words, from what it read against the version before it:
// "Written after Customer contracts was added. 6 apps.", "Written after changes to Hiring and Spend."
export function versionWhat(version: number, read: OntologyRead[], before: OntologyRead[] | null, by: string | null): string {
  const n = plural(read.length, "app");
  const regenerated = by ? ` Regenerated by ${by}.` : "";
  if (version === 1) return `First written, from ${n}.`;
  if (!before) return `Written from ${n}.${regenerated}`;
  const was = new Map(before.map((r) => [r.id, r]));
  const now = new Set(read.map((r) => r.id));
  const added = read.filter((r) => !was.has(r.id)).map((r) => r.name);
  const removed = before.filter((r) => !now.has(r.id)).map((r) => r.name);
  const changed = read.filter((r) => was.has(r.id) && (was.get(r.id)!.version !== r.version || was.get(r.id)!.name !== r.name)).map((r) => r.name);
  const parts = [
    ...(added.length ? [`${listOf(added)} ${added.length === 1 ? "was" : "were"} added`] : []),
    ...(removed.length ? [`${listOf(removed)} ${removed.length === 1 ? "was" : "were"} removed`] : []),
    ...(changed.length ? [`changes to ${listOf(changed)}`] : []),
  ];
  if (!parts.length) return `Written again; no app had changed.${regenerated}`;
  const count = added.length || removed.length ? ` ${n}.` : "";
  return `Written after ${listOf(parts)}.${count}${regenerated}`;
}

// Every kept version, newest first (admins only).
export async function listOntologyVersions(tx: Tx, ctx: KernelCtx): Promise<OntologyVersionItem[]> {
  await mustBeAdmin(tx, ctx);
  const loaded = await load(tx);
  const found = await tx
    .select({ version: ontologyVersions.version, read: ontologyVersions.read, writtenAt: ontologyVersions.writtenAt, writtenBy: ontologyVersions.writtenBy })
    .from(ontologyVersions)
    .orderBy(ontologyVersions.version);
  const firstName = (id: string | null) => (id ? (loaded.people.get(id)?.name.split(" ")[0] ?? null) : null);
  return found
    .map((v, i) => {
      const before = i > 0 && found[i - 1]!.version === v.version - 1 ? (found[i - 1]!.read as OntologyRead[]) : null;
      return { version: v.version, writtenAt: v.writtenAt, apps: (v.read as OntologyRead[]).length, what: versionWhat(v.version, v.read as OntologyRead[], before, firstName(v.writtenBy)) };
    })
    .reverse();
}

// One kept version (admins only), or null when there is none by that number.
export async function readOntologyVersion(tx: Tx, ctx: KernelCtx, version: number): Promise<(StoredOntology & { read: OntologyRead[] }) | null> {
  await mustBeAdmin(tx, ctx);
  if (!Number.isInteger(version) || version < 1) return null;
  const [v] = await tx.select().from(ontologyVersions).where(eq(ontologyVersions.version, version));
  return v ? { version: v.version, inputHash: v.inputHash, written: v.written as OntologyWritten, writtenAt: v.writtenAt, read: v.read as OntologyRead[] } : null;
}

// The apps and connections as a past version read them, from the app files at those versions, so its page shows
// the apps it described (an app added later isn't there; one since removed is). Owners are today's.
export async function pastInput(tx: Tx, ctx: KernelCtx, read: OntologyRead[]): Promise<Pick<OntologyInput, "capabilities" | "connections">> {
  await mustBeAdmin(tx, ctx);
  if (!read.length) return { capabilities: [], connections: [] };
  const loaded = await load(tx);
  const versions = await tx
    .select({ id: capabilityVersions.capabilityId, version: capabilityVersions.version, file: capabilityVersions.file })
    .from(capabilityVersions)
    .where(inArray(capabilityVersions.capabilityId, read.map((r) => r.id)));
  const owners = new Map(
    (await tx.select({ id: capabilitiesTable.id, ownerId: capabilitiesTable.ownerId }).from(capabilitiesTable).where(inArray(capabilitiesTable.id, read.map((r) => r.id)))).map((c) => [c.id, c.ownerId]),
  );
  const files = new Map<string, CapabilityFile>();
  for (const r of read) {
    const file = versions.find((v) => v.id === r.id && v.version === r.version)?.file as CapabilityFile | undefined;
    if (file) files.set(r.id, file);
  }
  const order = read.map((r) => r.id).filter((id) => files.has(id));
  const capabilities = order.map((id): OntologyCapability => {
    const file = files.get(id)!;
    const owner = owners.get(id);
    return {
      id,
      name: file.name,
      icon: file.icon,
      version: read.find((r) => r.id === id)!.version,
      text: file.sheets.map((s) => `${s.name} sheet:`).join("\n"),
      sheets: file.sheets.length,
      steps: stepsOf(file),
      owner: owner ? (loaded.people.get(owner)?.name.split(" ")[0] ?? null) : null,
      rows: 0,
    };
  });
  return { capabilities, connections: connectionsOf(order, files) };
}

// The banner over a past version (m34-c): "You're reading version 1, from Oct 14. It describes Hiring, … as they
// were then."
export function pastBanner(version: number, writtenAt: Date, names: string[], now: Date, timeZone: string, fmt: Formats = US): string {
  const when = writtenWhen(writtenAt, now, timeZone, fmt).split(", ").slice(0, -1).join(", ");
  const describes = names.length ? ` It describes ${listOf(names)} as ${names.length === 1 ? "it was" : "they were"} then.` : "";
  return `You're reading version ${version}, from ${when}.${describes}`;
}

// ── The page (4e) ──

export type OntologyView = {
  company: string;
  intro: string | null;
  paragraphs: string[];
  version: number | null;
  writtenAt: Date | null;
  capabilities: number;
  connections: { from: string; to: string; fromIcon: string; toIcon: string; fromColor?: string; toColor?: string; phrase: string }[];
  each: { name: string; icon: string; color?: string; sentence: string; meta: string }[];
  worth: string[];
};

// "Openings, candidates and interviews." from the sheet names, when prompt 6 hasn't written its sentence.
const sheetsSentence = (text: string) => {
  const sheets = text.split("\n").filter((l) => / sheet: /.test(l)).map((l) => l.split(" sheet:")[0]!);
  const list = sheets.map((s, i) => (i ? s.toLowerCase() : s));
  return `${list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : (list[0] ?? "")}.`;
};

// colors: each capability's icon colour by name (0.4, M23), kept out of the input the Ontology prompt reads.
export function ontologyView(input: OntologyInput, stored: StoredOntology | null, coherence: CoherenceItem[] = [], colors: ReadonlyMap<string, string> = new Map()): OntologyView {
  const w = stored?.written;
  const icon = new Map(input.capabilities.map((c) => [c.name, c.icon]));
  return {
    company: input.company.name,
    intro: w?.intro ?? null,
    paragraphs: w?.paragraphs ?? [],
    version: stored?.version ?? null,
    writtenAt: stored?.writtenAt ?? null,
    capabilities: input.capabilities.length,
    connections: input.connections.map((c) => ({ from: c.from, to: c.to, fromIcon: icon.get(c.from) ?? "layout-grid", toIcon: icon.get(c.to) ?? "layout-grid", fromColor: colors.get(c.from), toColor: colors.get(c.to), phrase: w?.phrases[c.key] ?? c.reading })),
    each: input.capabilities.map((c) => ({
      name: c.name,
      icon: c.icon,
      color: colors.get(c.name),
      sentence: w?.sentences[c.name] ?? sheetsSentence(c.text),
      meta: [plural(c.sheets, "sheet"), c.steps, c.owner ? `owned by ${c.owner}` : ""].filter(Boolean).join(" · "),
    })),
    worth: worthALook(coherence, w?.worth ?? []),
  };
}

// Download (4e): the page as plain text.
export function ontologyText(v: OntologyView): string {
  const lines = [`How ${v.company} runs`, ""];
  if (v.intro) lines.push(v.intro, "");
  if (v.paragraphs.length) lines.push("How it all fits together", "", ...v.paragraphs.flatMap((p) => [p, ""]));
  if (v.connections.length) lines.push("Every connection", "", ...v.connections.map((c) => `${c.from} → ${c.to}: ${c.phrase}`), "");
  lines.push("Each app in a sentence", "", ...v.each.flatMap((c) => [`${c.name}: ${c.sentence}`, `  ${c.meta}`]), "");
  if (v.worth.length) lines.push("Worth a look", "", ...v.worth.map((x) => `- ${x}`), "");
  return `${lines.join("\n").trimEnd()}\n`;
}

// "Written by Bike from the setup of your 6 capabilities · version 3 · regenerated today, 9:00 am".
// A past version (m34-c) reads "· version 1 · Oct 14, 4:10 pm".
export function ontologyLine(v: Pick<OntologyView, "capabilities" | "version" | "writtenAt">, now: Date, timeZone: string, fmt: Formats = US, past = false): string {
  const head = `Written by Bike from the setup of your ${plural(v.capabilities, "app", "apps")}`;
  if (!v.version || !v.writtenAt) return head;
  return `${head} · version ${v.version} · ${past ? "" : "regenerated "}${writtenWhen(v.writtenAt, now, timeZone, fmt)}`;
}

// "today, 9:00 am", "Oct 14, 4:10 pm".
export function writtenWhen(at: Date, now: Date, timeZone: string, fmt: Formats = US): string {
  const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const date = day(at) === day(now) ? "today" : formatDay(day(at), fmt);
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(at).toLowerCase();
  return `${date}, ${time}`;
}
