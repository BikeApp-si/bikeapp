import { and, eq, inArray, isNull } from "drizzle-orm";
import { capabilities, capabilityVersions, changeSets, people, rows } from "@/db/schema";
import { tintAt } from "@/lib/avatar";
import { formatDay, relativeDay, US, type Formats } from "@/lib/format";
import { accessTo } from "./access";
import { AccessError, load, teamOf, todayIn, type CurrentFile, type KernelCtx, type Loaded } from "./context";
import { countRows, type RowView } from "./rows";
import type { Column, Role, Sheet, Step } from "./schema/file";
import type { Tx } from "./tx";
import { uploadNames } from "./uploads";
import { rulesOn, type RuleEntry } from "./rule-set";
import { quickOf, tabsOf, type FormTab } from "./form";

// What a capability's Data tab needs, built from its file and the person's access. Hidden sheets are left
// out, not shown as locked.

export type SheetView = {
  id: string;
  name: string;
  kind: Sheet["kind"];
  titleColumn: string;
  row: { one: string; many: string };
  addAction: string;
  columns: Column[]; // in sheet order, without hint columns
  hints: Record<string, Column>; // column id → the computed column shown beside it
  steps: Step[];
  sort: Sheet["sort"] | null;
  canAdd: boolean;
  canEdit: boolean;
  canDelete: boolean;
  // A ledger (M29): its own columns. Its entries are never edited or deleted; whoever may add one may reverse one.
  ledger: Sheet["ledger"] | null;
  // A dated sheet (M30): its own columns. A row in force is never edited or deleted; one still to come may be.
  dated: Sheet["dated"] | null;
  count: number;
  tabs: FormTab[]; // the record's tabs (0.3)
  quick: string[]; // the questions asked when a row is added
  // A new row can be added as a row of the table (0.3, M18): not when it asks every question (it goes to someone), has
  // checks to show as it's filled in, or holds lines.
  quickRow: boolean;
  canShare: boolean; // may share a view with everyone who sees the sheet (0.4: an admin of the capability)
};

export type CapabilityView = {
  id: string;
  name: string;
  icon: string;
  color: string; // its icon's colour (0.4, M23)
  line: string;
  version: number;
  sheets: SheetView[];
};

export function rowWords(sheet: Sheet) {
  const row = sheet.row ?? { one: "row", many: "rows" };
  return { row, addAction: sheet.addAction ?? `New ${row.one}` };
}

// "Created Aug 12 from your message · owned by Wade Wilson", or the capability's own description.
async function headerLine(tx: Tx, loaded: Loaded, capId: string, description: string | undefined) {
  const [cap] = await tx.select({ createdAt: capabilities.createdAt, ownerId: capabilities.ownerId }).from(capabilities).where(eq(capabilities.id, capId));
  const [first] = await tx
    .select({ source: changeSets.source })
    .from(capabilityVersions)
    .innerJoin(changeSets, eq(changeSets.id, capabilityVersions.changeSetId))
    .where(and(eq(capabilityVersions.capabilityId, capId), eq(capabilityVersions.version, 1)));
  const day = todayIn(loaded.timeZone, cap!.createdAt);
  const from = first?.source === "build" ? "from your documents" : "from your message";
  // 5i: "Created from your message today"; later, "Created Aug 12 from your message".
  const created = day === todayIn(loaded.timeZone) ? `Created ${from} today` : `Created ${formatDay(day, loaded.formats)} ${from}`;
  const owner = cap?.ownerId ? loaded.people.get(cap.ownerId)?.name : undefined;
  return [description ?? created, owner ? `owned by ${owner}` : null].filter(Boolean).join(" · ");
}

export async function capabilityView(tx: Tx, ctx: KernelCtx, capId: string): Promise<CapabilityView> {
  const loaded = await load(tx);
  const access = await accessTo(tx, loaded, capId, ctx.actor.id);
  const seen = access?.cap.file.sheets.filter((s) => access.can("see", s.id)) ?? [];
  if (!access || !seen.length) throw new AccessError("That app doesn't exist, or you can't see it.");
  const { cap } = access;
  const sheets: SheetView[] = [];
  for (const s of seen) {
    const hints = Object.fromEntries(s.columns.filter((c) => c.hintFor).map((c) => [c.hintFor!, c]));
    sheets.push({
      id: s.id,
      name: s.name,
      kind: s.kind,
      titleColumn: s.titleColumn,
      ...rowWords(s),
      columns: s.columns.filter((c) => !c.hintFor),
      hints,
      steps: s.steps ?? [],
      sort: s.sort ?? null,
      canAdd: s.kind !== "lines" && access.can("add", s.id),
      canEdit: s.kind !== "ledger" && access.can("edit", s.id),
      canDelete: s.kind !== "ledger" && access.can("delete", s.id),
      ledger: s.ledger ?? null,
      dated: s.dated ?? null,
      count: await countRows(tx, ctx, capId, s.id),
      tabs: tabsOf(s),
      quick: quickOf(cap.file, capId, s, new Map([...loaded.files].map(([id, f]) => [id, f.file] as const))),
      quickRow: false,
      canShare: access.can("customize", s.id),
    });
    const v = sheets.at(-1)!;
    const fillable = s.columns.filter((c) => c.type !== "computed" && c.type !== "step" && !c.hintFor).length;
    v.quickRow = v.canAdd && s.kind === "list" && !s.checks?.length && v.quick.length < fillable;
  }
  const [own] = await tx.select({ color: capabilities.color }).from(capabilities).where(eq(capabilities.id, capId));
  return { id: cap.id, name: cap.file.name, icon: cap.file.icon, color: own?.color ?? "violet", line: await headerLine(tx, loaded, capId, cap.file.description), version: cap.version, sheets };
}

// Names for what rows point at: people, linked rows (only those the person can see) and files.
export async function namesFor(tx: Tx, ctx: KernelCtx, sheet: Sheet, list: RowView[]) {
  const loaded = await load(tx);
  const ids = (type: string) => [...new Set(list.flatMap((r) => sheet.columns.filter((c) => c.type === type).map((c) => r.data[c.id])).filter((v): v is string => typeof v === "string"))];
  const titles = await linkedTitles(tx, ctx, loaded, ids("link"));
  const people = Object.fromEntries([...loaded.people.values()].map((p) => [p.id, p.name]));
  const files = Object.fromEntries(await uploadNames(tx, ids("file")));
  return { people, rows: titles, files };
}

// The titles of linked rows the person may see, by id. A title that is itself a person, a choice or a link reads by
// name: a report card titled by its student reads "Riya Iyer" (G3), never the student's id. Two links deep at most.
async function linkedTitles(tx: Tx, ctx: KernelCtx, loaded: Loaded, ids: string[], depth = 0): Promise<Record<string, string>> {
  const titles: Record<string, string> = {};
  if (!ids.length) return titles;
  const found = await tx.select().from(rows).where(and(inArray(rows.id, ids), isNull(rows.deletedAt)));
  const seen: { id: string; sheet: Sheet; data: Record<string, unknown> }[] = [];
  for (const r of found) {
    const access = await accessTo(tx, loaded, r.capabilityId, ctx.actor.id);
    const s = access?.cap.file.sheets.find((x) => x.id === r.sheetId);
    const data = r.data as Record<string, unknown>;
    if (!access || !s || !(await access.allows("see", { ...r, data }))) continue;
    seen.push({ id: r.id, sheet: s, data });
  }
  return titlesOf(tx, ctx, loaded, seen, depth);
}

// Each row's title as a person reads it: a person or a choice by name, a linked row by its own title (when they may
// see it), anything else as it is.
async function titlesOf(tx: Tx, ctx: KernelCtx, loaded: Loaded, list: { id: string; sheet: Sheet; data: Record<string, unknown> }[], depth = 0) {
  const titles: Record<string, string> = {};
  const viaLink = list.filter((r) => r.sheet.columns.find((c) => c.id === r.sheet.titleColumn)?.type === "link");
  const ids = [...new Set(viaLink.map((r) => r.data[r.sheet.titleColumn]).filter((v): v is string => typeof v === "string"))];
  const next = depth < 1 ? await linkedTitles(tx, ctx, loaded, ids, depth + 1) : {};
  for (const r of list) {
    const col = r.sheet.columns.find((c) => c.id === r.sheet.titleColumn);
    const v = r.data[r.sheet.titleColumn];
    titles[r.id] =
      v == null ? "" : col?.type === "person" ? (loaded.people.get(String(v))?.name ?? "") : col?.type === "choice" ? (col.options?.find((o) => o.id === v)?.name ?? "") : col?.type === "link" ? (next[String(v)] ?? "") : String(v);
  }
  return titles;
}

// The rows a link field can point at, each by its title as the table reads it (G3: a fee card or report card titled by
// its student reads by the student's name).
export async function linkOptionTitles(tx: Tx, ctx: KernelCtx, sheet: Sheet, list: RowView[]): Promise<{ id: string; label: string }[]> {
  const loaded = await load(tx);
  const titles = await titlesOf(tx, ctx, loaded, list.map((r) => ({ id: r.id, sheet, data: r.data })));
  return list.map((r) => ({ id: r.id, label: titles[r.id] ?? "" }));
}

// Everyone in People with their avatar colour, for chips and person pickers.
export async function peoplePicker(tx: Tx): Promise<{ id: string; name: string; title: string | null; team: string | null; tint: string }[]> {
  const all = await tx.select({ id: people.id, name: people.name, title: people.title, team: people.team }).from(people).orderBy(people.seq);
  return all.map((p, i) => ({ ...p, tint: tintAt(i) }));
}

// --- role views (8a–8e, X1) -------------------------------------------------------------------------------

export type RoleView = NonNullable<Role["view"]>;

// The view a person gets in place of the Data tab, or null for the Data tab. Admins always get the Data tab.
// Otherwise the widest of the roles they hold on the view's sheet decides (all, then team when they have
// people below them, then own and team without them): a role with a view at that width gives them its view.
// Krishna, who sees all contracts, keeps the Data tab; Rita, who sees her own, gets 8c.
export async function roleViewFor(tx: Tx, ctx: KernelCtx, capId: string, isAdmin: boolean): Promise<RoleView | null> {
  if (isAdmin) return null;
  const loaded = await load(tx);
  const access = await accessTo(tx, loaded, capId, ctx.actor.id);
  if (!access) return null;
  const leads = teamOf(ctx.actor.id, loaded.people).size > 1;
  const width = (r: Role) => (r.scope === "all" ? 3 : r.scope === "team" && leads ? 2 : 1);
  const seeing = (sheetId: string) => access.roles.filter((r) => r.can.includes("see") && (!r.sheets || r.sheets.includes(sheetId)));
  // In file order: the first view whose role is as wide as any role they hold on that sheet.
  for (const role of access.roles) {
    if (role.view && width(role) === Math.max(...seeing(role.view.sheet).map(width))) return role.view;
  }
  return null;
}

// 7a's line under a row's title: the date a date rule on its sheet counts from ("Notice date passed Oct 15").
export function dateLine(rules: readonly RuleEntry[], cap: CurrentFile, sheet: Sheet, data: Record<string, unknown>, today: string, fmt: Formats = US): string | null {
  for (const { rule: r } of rulesOn(rules, cap.id, sheet.id)) {
    if (!r.enabled || r.trigger.kind !== "date_reached") continue;
    const col = sheet.columns.find((c) => c.id === r.trigger.date);
    const v = data[r.trigger.date ?? ""];
    if (!col || typeof v !== "string") continue;
    const day = v.slice(0, 10);
    return day < today ? `${col.name} passed ${formatDay(day, fmt)}` : `${col.name} ${relativeDay(day, today)}`;
  }
  return null;
}
