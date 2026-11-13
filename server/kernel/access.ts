import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { rows } from "@/db/schema";
import { teamOf, type CurrentFile, type Loaded } from "./context";
import type { Permission, Role, Sheet } from "./schema/file";
import type { Tx } from "./tx";
import { holds } from "./holds";

// Who may see and do what in a capability: the person's roles, each with its permissions and scope.
// Scope all: every row. own: rows whose person column is them. team: them or anyone below them in the
// manager chain. The person column is on the row, or one hop through a link column. Lines go with their
// document. Access comes only from roles; being an admin gives no rows.

export type RowRef = { id?: string; sheetId: string; data: Record<string, unknown>; parentRowId?: string | null };

export type Access = {
  cap: CurrentFile;
  roles: Role[];
  // Whether any role gives this permission on the sheet, before looking at a row.
  can(perm: Permission, sheetId: string): boolean;
  // Whether a role with this permission covers this row. move_steps also checks the step it is in.
  allows(perm: Permission, row: RowRef, step?: string | null): Promise<boolean>;
  // A filter on `rows` (under the given alias) for the rows this person can see; null when none.
  visible(sheetId: string, alias?: string): SQL | null;
};

// The sheet whose roles and scope decide: a line's document sheet, otherwise the sheet itself.
export function decidingSheet(cap: CurrentFile, sheetId: string): Sheet | undefined {
  const sheet = cap.file.sheets.find((s) => s.id === sheetId);
  return sheet?.kind === "lines" ? cap.file.sheets.find((s) => s.id === sheet.parentSheet) : sheet;
}

// Answers a job worked out in advance for many people at once (the morning emails, M12): who is in each role whose
// members come from a column, and the rows that access looks through (links, a line's document). Only within the
// job's own loaded setup, which writes no rows.
export type RowSeen = { capabilityId: string; sheetId: string; data: Record<string, unknown> };
export type Primed = { members: Map<string, Set<string>>; rows: Map<string, RowSeen | null> };
const primedFor = new WeakMap<Loaded, Primed>();
export const prime = (loaded: Loaded, p: Primed) => void primedFor.set(loaded, p);
export const unprime = (loaded: Loaded) => void primedFor.delete(loaded);
export const primed = (loaded: Loaded) => primedFor.get(loaded);
export const memberKey = (capId: string, sheet: string, column: string) => `${capId}:${sheet}:${column}`;

const UUID_TEXT = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

const covers = (role: Role, sheetId: string) => !role.sheets || role.sheets.includes(sheetId);

async function isMember(tx: Tx, loaded: Loaded, cap: CurrentFile, role: Role, personId: string): Promise<boolean> {
  const m = role.members;
  if (m.kind === "everyone") return true;
  if (m.kind === "people") return m.people.includes(personId);
  const known = primed(loaded)?.members.get(memberKey(cap.id, m.sheet, m.column));
  if (known) return known.has(personId);
  const [hit] = await tx
    .select({ id: rows.id })
    .from(rows)
    .where(and(eq(rows.capabilityId, cap.id), eq(rows.sheetId, m.sheet), isNull(rows.deletedAt), holds(m.column, personId)))
    .limit(1);
  return !!hit;
}

// A person's access to a capability, worked out once per loaded setup (one kernel call, or one request when the
// setup is shared): a page that checks many linked rows asks for it many times (M12, docs/kernel-study.md).
const built = new WeakMap<Loaded, Map<string, Promise<Access | null>>>();

export function accessTo(tx: Tx, loaded: Loaded, capabilityId: string, personId: string): Promise<Access | null> {
  let forLoaded = built.get(loaded);
  if (!forLoaded) built.set(loaded, (forLoaded = new Map()));
  const key = `${capabilityId}:${personId}`;
  let access = forLoaded.get(key);
  if (!access) forLoaded.set(key, (access = build(tx, loaded, capabilityId, personId)));
  return access;
}

async function build(tx: Tx, loaded: Loaded, capabilityId: string, personId: string): Promise<Access | null> {
  const cap = loaded.files.get(capabilityId);
  if (!cap) return null;
  const roles: Role[] = [];
  for (const r of cap.file.roles) if (await isMember(tx, loaded, cap, r, personId)) roles.push(r);

  const own = new Set([personId]);
  const idsFor = (role: Role) => (role.scope === "own" ? own : teamOf(personId, loaded.people));
  const rolesWith = (perm: Permission, sheetId: string) => {
    const sheet = decidingSheet(cap, sheetId);
    return sheet ? roles.filter((r) => r.can.includes(perm) && covers(r, sheet.id)) : [];
  };

  // Whose the row is, by one role's scope column; null when the role sees every row.
  async function owner(role: Role, sheet: Sheet, data: Record<string, unknown>): Promise<unknown> {
    const sc = role.scopeColumns?.[sheet.id];
    if (!sc) return undefined;
    if (!sc.via) return data[sc.column];
    const linked = data[sc.via];
    if (typeof linked !== "string") return undefined;
    const seen = primed(loaded)?.rows;
    if (seen?.has(linked)) return seen.get(linked)?.data[sc.column];
    const [row] = await tx.select({ data: rows.data }).from(rows).where(and(eq(rows.id, linked), isNull(rows.deletedAt)));
    return (row?.data as Record<string, unknown> | undefined)?.[sc.column];
  }

  async function deciding(row: RowRef): Promise<{ sheet: Sheet; data: Record<string, unknown> } | null> {
    const sheet = cap!.file.sheets.find((s) => s.id === row.sheetId);
    if (!sheet) return null;
    if (sheet.kind !== "lines") return { sheet, data: row.data };
    if (!row.parentRowId) return null;
    const seen = primed(loaded)?.rows;
    if (seen?.has(row.parentRowId)) {
      const doc = seen.get(row.parentRowId);
      const parentSheet = decidingSheet(cap!, sheet.id);
      return doc && parentSheet ? { sheet: parentSheet, data: doc.data } : null;
    }
    const [parent] = await tx.select({ data: rows.data }).from(rows).where(and(eq(rows.id, row.parentRowId), isNull(rows.deletedAt)));
    const parentSheet = decidingSheet(cap!, sheet.id);
    return parent && parentSheet ? { sheet: parentSheet, data: parent.data as Record<string, unknown> } : null;
  }

  function filterFor(role: Role, sheet: Sheet, alias: string): SQL {
    if (role.scope === "all") return sql`true`;
    const sc = role.scopeColumns?.[sheet.id];
    if (!sc) return sql`false`;
    const ids = sql.join([...idsFor(role)].map((id) => sql`${id}`), sql`, `);
    const a = sql.raw(alias);
    if (!sc.via) return sql`${a}.data->>${sc.column} in (${ids})`;
    // The linked row by its id, so Postgres goes straight to it; a value that isn't an id links to nothing.
    const linked = sql`(case when ${a}.data->>${sc.via} ~* ${UUID_TEXT} then (${a}.data->>${sc.via})::uuid end)`;
    return sql`exists (select 1 from rows hop where hop.id = ${linked} and hop.deleted_at is null and hop.data->>${sc.column} in (${ids}))`;
  }

  return {
    cap,
    roles,
    can: (perm, sheetId) => rolesWith(perm, sheetId).length > 0,

    async allows(perm, row, step) {
      const d = await deciding(row);
      if (!d) return false;
      for (const role of rolesWith(perm, row.sheetId)) {
        if (perm === "move_steps" && role.moveFrom && (!step || !role.moveFrom.includes(step))) continue;
        if (role.scope === "all") return true;
        const who = await owner(role, d.sheet, d.data);
        if (typeof who === "string" && idsFor(role).has(who)) return true;
      }
      return false;
    },

    visible(sheetId, alias = "r") {
      const sheet = cap.file.sheets.find((s) => s.id === sheetId);
      const decider = decidingSheet(cap, sheetId);
      const seeing = rolesWith("see", sheetId);
      if (!sheet || !decider || !seeing.length) return null;
      // Parenthesised as a whole, so the "or" never escapes the conditions it is added to.
      if (sheet.kind !== "lines") return sql`(${sql.join(seeing.map((r) => sql`(${filterFor(r, decider, alias)})`), sql` or `)})`;
      // A line is visible when its document is.
      const parent = sql.join(seeing.map((r) => sql`(${filterFor(r, decider, "doc")})`), sql` or `);
      return sql`exists (select 1 from rows doc where doc.id = ${sql.raw(alias)}.parent_row_id and doc.deleted_at is null and (${parent}))`;
    },
  };
}
