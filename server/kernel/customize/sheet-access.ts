import type { CapabilityFile, Column, Role, Sheet } from "../schema/file";

// Who sees a sheet's rows, per role (C1). Written only with what roles already express (a role's sheets, its
// scope columns, and one more role beside it), so access.ts enforces it as it is. Roles are only ever added or
// narrowed, never removed. Pure: each function changes the file it's given and nothing else.

export type SheetAccess =
  | { role: string; sheet: string; sees: "all" }
  | { role: string; sheet: string; sees: "none" }
  | { role: string; sheet: string; sees: "by_column"; column: string }
  | { role: string; sheet: string; sees: "through_link"; via: string; column: string };

export class AccessChangeError extends Error {}

const covers = (r: Role, s: Sheet) => !r.sheets || r.sheets.includes(s.id);
const decides = (f: CapabilityFile) => f.sheets.filter((s) => s.kind !== "lines");

// The person column that says whose a new sheet's row is: one called Owner, else the one filled with whoever
// adds the row, else the only person column.
export function ownerColumn(sheet: Sheet): Column | undefined {
  const persons = sheet.columns.filter((c) => c.type === "person");
  return (
    persons.find((c) => c.name.trim().toLowerCase() === "owner") ??
    persons.find((c) => c.default?.kind === "creator") ??
    (persons.length === 1 ? persons[0] : undefined)
  );
}

// A link on the new sheet to a sheet the role decides by a person column of its own: whose the linked row is.
function linkedOwner(file: CapabilityFile, role: Role, sheet: Sheet): { via: string; column: string } | undefined {
  for (const c of sheet.columns) {
    if (c.type !== "link" || !c.link || c.link.capability) continue;
    const sc = role.scopeColumns?.[c.link.sheet];
    if (sc && !sc.via && file.sheets.some((s) => s.id === c.link!.sheet)) return { via: c.id, column: sc.column };
  }
  return undefined;
}

// What a role that sees only some rows does with a sheet added by Customize: whose each row is by its person
// column, or one link away; with neither, the role stops covering it, so admins see it first.
export function defaultAccess(file: CapabilityFile, sheet: Sheet): void {
  if (sheet.kind === "lines") return;
  if (sheet.kind === "ledger") return ledgerAccess(file, sheet);
  for (const role of file.roles) {
    if (role.scope === "all" || role.sheets) continue;
    const own = ownerColumn(sheet);
    const link = own ? undefined : linkedOwner(file, role, sheet);
    if (own) role.scopeColumns = { ...role.scopeColumns, [sheet.id]: { column: own.id } };
    else if (link) role.scopeColumns = { ...role.scopeColumns, [sheet.id]: link };
    else role.sheets = decides(file).filter((s) => s.id !== sheet.id).map((s) => s.id);
  }
}

// A ledger added by Customize (M29). A role that sees only its own rows gets, beside it, a role that only sees the
// entries that name them (their own leave), when the ledger is kept by person; it never adds, changes or reverses
// one, or employees could give themselves days. A role that sees its team's rows stops covering it: who else sees
// someone's entries is an admin's choice, said in Customize. Roles that see every row are as for any new sheet.
function ledgerAccess(file: CapabilityFile, sheet: Sheet): void {
  const account = sheet.columns.find((c) => c.id === sheet.ledger?.account);
  for (const role of [...file.roles]) {
    if (role.scope === "all" || role.beside) continue;
    if (covers(role, sheet)) role.sheets = decides(file).filter((s) => s.id !== sheet.id && covers(role, s)).map((s) => s.id);
    if (role.scope === "own" && account?.type === "person" && role.can.includes("see")) seeOnly(file, role, sheet, account.id);
  }
}

function seeOnly(file: CapabilityFile, role: Role, sheet: Sheet, column: string): void {
  let id = `${role.id}_${sheet.id}`;
  for (let n = 2; file.roles.some((r) => r.id === id); n++) id = `${role.id}_${sheet.id}_${n}`;
  file.roles.push({ id, name: `${role.name} on ${sheet.name}`, members: structuredClone(role.members), can: ["see"], sheets: [sheet.id], scope: "own", scopeColumns: { [sheet.id]: { column } }, beside: { role: role.id, sheet: sheet.id } });
}

// The role added beside this one for this sheet, if there is one (switched off or not).
const besideFor = (file: CapabilityFile, role: Role, sheet: Sheet) => file.roles.find((r) => r.beside?.role === role.id && r.beside.sheet === sheet.id);

// A role beside another, switched off: it covers nothing, so its role decides alone again.
function switchOff(file: CapabilityFile, role: Role, sheet: Sheet): void {
  const b = besideFor(file, role, sheet);
  if (!b) return;
  b.sheets = [];
  delete b.scopeColumns;
}

function without(file: CapabilityFile, role: Role, sheet: Sheet): void {
  role.sheets = decides(file).filter((s) => s.id !== sheet.id && covers(role, s)).map((s) => s.id);
  if (role.scopeColumns) {
    const rest = { ...role.scopeColumns };
    delete rest[sheet.id];
    if (Object.keys(rest).length) role.scopeColumns = rest;
    else delete role.scopeColumns;
  }
  if (!role.sheets.length) throw new AccessChangeError(`${role.name} would see nothing in ${file.name}. Say which sheets they should see instead.`);
}

function including(role: Role, sheet: Sheet): void {
  if (role.sheets && !role.sheets.includes(sheet.id)) role.sheets = [...role.sheets, sheet.id];
}

// The same people with the same permissions, on this one sheet, seeing its rows another way.
function sibling(file: CapabilityFile, role: Role, sheet: Sheet, scope: Role["scope"], sc?: { column: string; via?: string }): void {
  const i = file.roles.findIndex((r) => r.beside?.role === role.id && r.beside.sheet === sheet.id);
  // A fresh id, never one another role already has.
  let id = `${role.id}_${sheet.id}`;
  for (let n = 2; i < 0 && file.roles.some((r) => r.id === id); n++) id = `${role.id}_${sheet.id}_${n}`;
  const steps = new Set((sheet.steps ?? []).map((s) => s.id));
  const next: Role = {
    id: i >= 0 ? file.roles[i]!.id : id,
    name: `${role.name} on ${sheet.name}`,
    members: structuredClone(role.members),
    // On a ledger, a role that sees only some rows only sees them (M29): adding an entry for yourself is an admin's.
    can: sheet.kind === "ledger" && role.scope !== "all" ? ["see"] : role.can.filter((c) => c !== "customize"),
    ...(role.moveFrom ? { moveFrom: role.moveFrom.filter((s) => steps.has(s)) } : {}),
    sheets: [sheet.id],
    scope,
    ...(sc ? { scopeColumns: { [sheet.id]: sc } } : {}),
    beside: { role: role.id, sheet: sheet.id },
  };
  if (!next.can.length) throw new AccessChangeError(`${role.name} can only change how ${file.name} works, so it has no rows to see.`);
  if (i >= 0) file.roles[i] = next;
  else file.roles.push(next);
}

export function setSheetAccess(file: CapabilityFile, a: SheetAccess): void {
  // A role beside another is changed through its role, as the text and the prompts show it.
  const named = file.roles.find((r) => r.id === a.role);
  const role = named?.beside ? file.roles.find((r) => r.id === named.beside!.role) : named;
  const sheet = file.sheets.find((s) => s.id === a.sheet);
  if (!role) throw new AccessChangeError(`${file.name} has no role “${a.role}”.`);
  if (!sheet) throw new AccessChangeError(`${file.name} has no sheet “${a.sheet}”.`);
  if (sheet.kind === "lines") throw new AccessChangeError(`${sheet.name} go with their ${file.sheets.find((s) => s.id === sheet.parentSheet)?.name ?? "document"}; who sees them is set there.`);
  if (a.sees === "none") {
    switchOff(file, role, sheet);
    if (covers(role, sheet)) without(file, role, sheet);
    return;
  }
  const sc = a.sees === "by_column" ? { column: a.column } : a.sees === "through_link" ? { via: a.via, column: a.column } : undefined;
  // A ledger, for a role that sees only some rows and may do more than see: only seen, by a role beside it (M29).
  if (sheet.kind === "ledger" && role.scope !== "all" && role.can.some((c) => c !== "see")) {
    if (covers(role, sheet)) without(file, role, sheet);
    return sibling(file, role, sheet, sc ? "own" : "all", sc);
  }
  // A role that already sees rows the way asked for: it covers the sheet, with its column if it needs one.
  if ((a.sees === "all") === (role.scope === "all")) {
    switchOff(file, role, sheet);
    including(role, sheet);
    if (sc) role.scopeColumns = { ...role.scopeColumns, [sheet.id]: sc };
    return;
  }
  // A role on this sheet alone changes how it sees it.
  if (decides(file).every((s) => s.id === sheet.id || !covers(role, s))) {
    role.scope = sc ? "own" : "all";
    if (sc) role.scopeColumns = { [sheet.id]: sc };
    else delete role.scopeColumns;
    return;
  }
  // Otherwise the role steps back from the sheet and one beside it sees it the new way.
  if (covers(role, sheet)) without(file, role, sheet);
  sibling(file, role, sheet, sc ? "own" : "all", sc);
}

// How each role that sees only some rows will see each sheet, in plain words, where a change set alters it
// ("Lead owners see their own companies, by Owner.", "Lead owners won't see Companies yet.").
type Seeing = { how: "none" } | { how: "all" } | { how: "own"; by: string };

function seeing(file: CapabilityFile, role: Role, sheet: Sheet): Seeing {
  if (!covers(role, sheet) || !role.can.includes("see")) return { how: "none" };
  if (role.scope === "all") return { how: "all" };
  const sc = role.scopeColumns?.[sheet.id];
  if (!sc) return { how: "none" };
  const col = (s: Sheet | undefined, id: string) => s?.columns.find((c) => c.id === id)?.name ?? id;
  if (!sc.via) return { how: "own", by: col(sheet, sc.column) };
  const link = sheet.columns.find((c) => c.id === sc.via);
  return { how: "own", by: `${link?.name ?? sc.via}'s ${col(file.sheets.find((s) => s.id === link?.link?.sheet), sc.column)}` };
}

// For prompt 3: how one role sees one sheet's rows, by name.
export function seeingWords(file: CapabilityFile, role: Role, sheet: Sheet): string {
  const s = seeing(file, role, sheet);
  return s.how === "all" ? "every row" : s.how === "own" ? `${role.scope === "team" ? "their team's" : "their own"} rows, by ${s.by}` : "none of its rows";
}

// How a role sees a sheet, the role beside it included (when it's on, it's how the role sees that sheet).
function seeingWith(file: CapabilityFile, role: Role, sheet: Sheet): Seeing & { team?: boolean } {
  const b = besideFor(file, role, sheet);
  const r = b && covers(b, sheet) && b.sheets?.length ? b : role;
  return { ...seeing(file, r, sheet), ...(r.scope === "team" ? { team: true } : {}) };
}

export function accessLines(before: CapabilityFile, after: CapabilityFile): string[] {
  const out: string[] = [];
  for (const sheet of decides(after)) {
    const was = before.sheets.find((s) => s.id === sheet.id);
    const one = sheet.row?.one ?? `row in ${sheet.name}`;
    const many = sheet.row?.many ?? `rows in ${sheet.name}`;
    // Roles beside another are said through their role.
    for (const role of after.roles.filter((r) => !r.beside)) {
      const prior = before.roles.find((r) => r.id === role.id);
      // Admins see everything; only roles that see some rows are said.
      if (!was && role.scope === "all" && !role.sheets && prior) continue;
      const now = seeingWith(after, role, sheet);
      const then = was && prior ? seeingWith(before, prior, was) : null;
      if (then && JSON.stringify(then) === JSON.stringify(now)) continue;
      if (now.how === "none" && (!prior || then?.how === "none")) continue;
      const line =
        now.how === "all"
          ? `${role.name} see every ${one}.`
          : now.how === "own"
            ? `${role.name} see ${now.team ? "their team's" : "their own"} ${many}, by ${now.by}.`
            : was
              ? `${role.name} won't see ${sheet.name} any more.`
              : `${role.name} won't see ${sheet.name} yet.`;
      if (!out.includes(line)) out.push(line);
    }
  }
  return out;
}
