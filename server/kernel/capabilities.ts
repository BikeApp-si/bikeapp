import { dropCompanyRulesFor } from "./company-rules";
import { forgetSetup } from "./setup-cache";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { nextCapColor } from "@/lib/cap-colors";
import { sameJson } from "@/lib/same-json";
import { capabilities, capabilityVersions, changeSets, rows } from "@/db/schema";
import { accessTo } from "./access";
import { record } from "./audit";
import { KernelError, load, type KernelCtx } from "./context";
import type { CapabilityFile, Rule } from "./schema/file";
import { mustBeAdmin } from "./admin";
import { findLoop } from "./rule-graph";
import { companyEntries, ruleSetOf, rulesOf } from "./rule-set";
import { validateFile } from "./schema/validate";
import { atomic, type Tx } from "./tx";
import { currentTime } from "./clock";

// Capability files and their versions. A change never edits a file: it adds a version and moves the pointer.

export type SaveOptions = {
  source: "customize" | "plan" | "build" | "gallery";
  set?: { name: string; version: number }; // gallery (G1): the app set added, and its version
  kind?: "add" | "restructure"; // M27: restructure when the change set also moves rows
  chatId?: string | null;
  at?: Date; // when the change was made; now when left out (the seed sets the dates the screens show)
  changeSetId?: string; // part of a change set already made for several capabilities (changesets.ts)
  // The other capabilities' files as the whole change set leaves them, by id. A file in a change set is checked
  // against those (it may read what another part of the same change set adds), not against the files saved
  // so far. Left out, the saved files.
  others?: ReadonlyMap<string, CapabilityFile>;
};

// "1 sheet, 5 steps, 2 rules, 2 roles", as the Audit log shows it. Steps are counted as the plain text writes
// them: a sheet's end steps together are one ("Renewed or Ended").
export function summary(file: CapabilityFile): string {
  const steps = file.sheets.reduce((n, s) => {
    const flow = s.steps ?? [];
    return n + flow.filter((st) => !st.end).length + (flow.some((st) => st.end) ? 1 : 0);
  }, 0);
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  return [n(file.sheets.length, "sheet"), n(steps, "step"), n(file.rules.length, "rule"), n(file.roles.length, "role")].join(", ");
}

async function checked(tx: Tx, raw: unknown, selfId?: string, world?: ReadonlyMap<string, CapabilityFile>): Promise<CapabilityFile> {
  const loaded = await load(tx);
  const others = new Map(world ? [...world].filter(([id]) => id !== selfId) : [...loaded.files].filter(([id]) => id !== selfId).map(([id, f]) => [id, f.file] as const));
  const result = validateFile(raw, { selfId, others, people: new Set(loaded.people.keys()) });
  if (!result.ok) throw new KernelError(`The app file isn't valid: ${result.errors[0]}`, result.errors);
  // A rule that would set itself off again through another capability is never saved.
  // Company rules count too: a loop may pass through one (0.2).
  const saved = new Map([...others, [selfId ?? "new", result.file]]);
  const loop = findLoop(saved, [...ruleSetOf(saved), ...companyEntries(loaded.rules)]);
  if (loop) throw new KernelError(loop);
  return result.file;
}

// What a new version does to the rules: each one added, changed or removed, for its own rule.saved entry.
function ruleChanges(before: CapabilityFile, after: CapabilityFile) {
  const was = new Map(before.rules.map((r) => [r.id, r]));
  const now = new Set(after.rules.map((r) => r.id));
  return [
    ...after.rules.filter((r) => !was.has(r.id) || !sameJson(was.get(r.id), r)).map((r) => ({ rule: r.text, change: was.has(r.id) ? "changed" : "added" })),
    ...before.rules.filter((r) => !now.has(r.id)).map((r) => ({ rule: r.text, change: "removed" })),
  ];
}

export async function newChangeSet(tx: Tx, ctx: KernelCtx, opts: SaveOptions, items: { capabilityId: string; fromVersion: number; toVersion: number }[]) {
  const [cs] = await tx
    .insert(changeSets)
    .values({
      workspaceId: ctx.workspaceId,
      source: opts.source,
      kind: opts.kind ?? "add",
      chatId: opts.chatId ?? null,
      items,
      setName: opts.set?.name ?? null,
      setVersion: opts.set?.version ?? null,
      createdBy: ctx.actor.id,
      createdAt: opts.at ?? ctx.now ?? currentTime(),
    })
    .returning({ id: changeSets.id });
  return cs!.id;
}

export async function createCapability(tx: Tx, ctx: KernelCtx, raw: unknown, given: SaveOptions & { ownerId?: string; id?: string }) {
  const opts = { ...given, at: given.at ?? ctx.now ?? currentTime() };
  const id = opts.id ?? crypto.randomUUID();
  const file = await checked(tx, raw, id, opts.others);
  // The colour after the most recently added capability's, removed ones counted, so no colour ever shifts.
  const [last] = await tx.select({ color: capabilities.color }).from(capabilities).orderBy(desc(capabilities.position)).limit(1);
  await tx.insert(capabilities).values({
    id,
    workspaceId: ctx.workspaceId,
    name: file.name,
    icon: file.icon,
    color: nextCapColor(last?.color),
    ownerId: opts.ownerId ?? ctx.actor.id,
    currentVersion: 1,
    createdAt: opts.at,
  });
  forgetSetup();
  const changeSetId = opts.changeSetId ?? (await newChangeSet(tx, ctx, opts, [{ capabilityId: id, fromVersion: 0, toVersion: 1 }]));
  await tx.insert(capabilityVersions).values({
    workspaceId: ctx.workspaceId,
    capabilityId: id,
    version: 1,
    file,
    changeSetId,
    createdBy: ctx.actor.id,
    createdAt: opts.at,
  });
  forgetSetup();
  await record(tx, ctx, {
    who: ctx.actor.email,
    capabilityId: id,
    event: "capability.created",
    details: { version: 1, summary: summary(file) },
    changeSetId,
    chatId: opts.chatId,
    at: opts.at,
  });
  return { id, version: 1, changeSetId };
}

// A new version of one capability. The event and its details say what changed (customize.saved in M6).
export async function saveVersion(
  tx: Tx,
  ctx: KernelCtx,
  capabilityId: string,
  raw: unknown,
  opts: SaveOptions & { event: string; details?: Record<string, unknown> },
) {
  opts = { ...opts, at: opts.at ?? ctx.now ?? currentTime() };
  const [cap] = await tx
    .select({ version: capabilities.currentVersion })
    .from(capabilities)
    .where(eq(capabilities.id, capabilityId))
    .for("update");
  if (!cap) throw new KernelError("That app doesn't exist.");
  const file = await checked(tx, raw, capabilityId, opts.others);
  const before = (await getFile(tx, capabilityId))!.file;
  const version = cap.version + 1;
  const changeSetId = opts.changeSetId ?? (await newChangeSet(tx, ctx, opts, [{ capabilityId, fromVersion: cap.version, toVersion: version }]));
  await tx.insert(capabilityVersions).values({
    workspaceId: ctx.workspaceId,
    capabilityId,
    version,
    file,
    changeSetId,
    createdBy: ctx.actor.id,
    createdAt: opts.at,
  });
  await tx.update(capabilities).set({ currentVersion: version, name: file.name, icon: file.icon }).where(eq(capabilities.id, capabilityId));
  forgetSetup();
  await record(tx, ctx, {
    who: ctx.actor.email,
    capabilityId,
    event: opts.event,
    details: { from: cap.version, to: version, ...opts.details },
    changeSetId,
    chatId: opts.chatId,
    at: opts.at,
  });
  for (const change of ruleChanges(before, file))
    await record(tx, ctx, { who: ctx.actor.email, capabilityId, event: "rule.saved", details: { version, ...change }, changeSetId, chatId: opts.chatId, at: opts.at });
  return { version, changeSetId };
}

// A capability's file, at its current version or an earlier one.
export async function getFile(tx: Tx, capabilityId: string, version?: number): Promise<{ version: number; file: CapabilityFile } | null> {
  const [cap] = await tx.select({ version: capabilities.currentVersion }).from(capabilities).where(eq(capabilities.id, capabilityId));
  if (!cap) return null;
  const v = version ?? cap.version;
  const [row] = await tx
    .select({ file: capabilityVersions.file })
    .from(capabilityVersions)
    .where(and(eq(capabilityVersions.capabilityId, capabilityId), eq(capabilityVersions.version, v)));
  return row ? { version: v, file: row.file as CapabilityFile } : null;
}

// The capabilities a person can see (any role that sees a sheet), in the sidebar's order.
export async function capabilitiesFor(tx: Tx, ctx: KernelCtx): Promise<{ id: string; name: string; icon: string; color: string }[]> {
  const loaded = await load(tx);
  const found = await tx
    .select({ id: capabilities.id, name: capabilities.name, icon: capabilities.icon, color: capabilities.color })
    .from(capabilities)
    .where(isNull(capabilities.deletedAt))
    .orderBy(capabilities.position);
  const out = [];
  for (const cap of found) {
    const access = await accessTo(tx, loaded, cap.id, ctx.actor.id);
    if (access?.cap.file.sheets.some((s) => access.can("see", s.id))) out.push(cap);
  }
  return out;
}

// Customize (6a–6l) is for an admin on a capability they can see. One hidden from them answers as one that
// isn't there, so its file never reaches their Customize chat or its prompt.
export async function mustCustomize(tx: Tx, ctx: KernelCtx, capabilityId: string) {
  await mustBeAdmin(tx, ctx);
  if (!(await capabilitiesFor(tx, ctx)).some((c) => c.id === capabilityId)) throw new KernelError("That app doesn't exist.");
}

// --- deleting a capability (9d, X7): admins only, by typing its name ---------------------------------------

// What deleting takes away: rows per sheet (all of them, not only the ones the admin can see), the files in
// them, who loses access, and the rules that hand work into it or out of it.
export async function deleteImpact(tx: Tx, ctx: KernelCtx, capabilityId: string) {
  await mustBeAdmin(tx, ctx);
  const loaded = await load(tx);
  const cap = loaded.files.get(capabilityId);
  if (!cap) throw new KernelError("That app doesn't exist.");
  const counted = await tx
    .select({ sheetId: rows.sheetId, n: sql<number>`count(*)::int` })
    .from(rows)
    .where(and(eq(rows.capabilityId, capabilityId), isNull(rows.deletedAt)))
    .groupBy(rows.sheetId);
  const fileCols = cap.file.sheets.flatMap((s) => s.columns.filter((c) => c.type === "file").map((c) => ({ sheet: s.id, column: c.id })));
  const [files] = fileCols.length
    ? await tx
        .select({ n: sql<number>`count(distinct v)::int` })
        .from(
          sql`(${sql.join(
            fileCols.map((f) => sql`select data->>${f.column} as v from rows where capability_id = ${capabilityId} and sheet_id = ${f.sheet} and deleted_at is null`),
            sql` union all `,
          )}) f`,
        )
        .where(sql`v is not null`)
    : [{ n: 0 }];

  // Who loses access: everyone a role names, other than the admin deleting it.
  const everyone = cap.file.roles.some((r) => r.members.kind === "everyone");
  const named = new Set<string>();
  for (const p of loaded.people.keys()) {
    if (p === ctx.actor.id) continue;
    if ((await accessTo(tx, loaded, capabilityId, p))?.roles.length) named.add(p);
  }
  const targets = (actions: Rule["actions"]) => actions.flatMap((a) => ("target" in a ? [a.target.capability] : []));
  const into = loaded.rules
    .filter((e) => e.capabilityId !== capabilityId && targets(e.rule.actions).includes(capabilityId))
    .map((e) => ({ direction: "into" as const, capability: loaded.files.get(e.capabilityId)?.file.name ?? "", text: e.rule.text }));
  // Out of it: named by the capability each one hands work to.
  const outOf = rulesOf(loaded.rules, capabilityId).flatMap(({ rule: r }) => {
    const other = targets(r.actions).find((t) => t && t !== capabilityId);
    return other ? [{ direction: "out" as const, capability: loaded.files.get(other)?.file.name ?? "", text: r.text }] : [];
  });
  // People fills every person column (X7: "People fills Owner").
  const people = [...new Set(cap.file.sheets.flatMap((s) => s.columns.filter((c) => c.type === "person").map((c) => c.name)))].map((name) => ({
    direction: "into" as const,
    capability: "People",
    text: `People fills ${name}`,
  }));

  // Link columns in other capabilities that point at it: while one is there it can't be deleted, since that
  // file could no longer be saved (0.1 never removes a column).
  const linkedFrom = [...loaded.files.values()]
    .filter((f) => f.id !== capabilityId)
    .flatMap((f) =>
      f.file.sheets.flatMap((s) => s.columns.filter((c) => c.type === "link" && c.link?.capability === capabilityId).map((c) => ({ capability: f.file.name, sheet: s.name, column: c.name }))),
    );
  const refused = linkedFrom.length
    ? `${cap.file.name} can’t be deleted while ${linkedFrom.map((l) => `${l.capability} links to it in its ${l.column} column (${l.sheet})`).join(" and ")}.`
    : null;

  return {
    name: cap.file.name,
    linkedFrom,
    refused,
    sheets: cap.file.sheets.map((s) => ({ name: s.name, row: s.row ?? { one: "row", many: "rows" }, count: counted.find((c) => c.sheetId === s.id)?.n ?? 0 })),
    files: files?.n ?? 0,
    loseAccess: everyone ? ("everyone" as const) : [...named].map((id) => loaded.people.get(id)!.name).sort((a, b) => a.localeCompare(b)),
    connections: [...people, ...into, ...outOf],
  };
}

export async function deleteCapability(tx: Tx, ctx: KernelCtx, capabilityId: string, typedName: string) {
  return atomic(tx, async (tx) => {
    const impact = await deleteImpact(tx, ctx, capabilityId);
    if (impact.refused) throw new KernelError(impact.refused);
    if (typedName.trim() !== impact.name) throw new KernelError(`Type ${impact.name} to confirm.`);
    const at = ctx.now ?? currentTime();
    await tx.update(capabilities).set({ deletedAt: at }).where(eq(capabilities.id, capabilityId));
    forgetSetup();
    // Company rules' parts on it, or handing work into it, stop first (a new company-rules version, 0.2).
    await dropCompanyRulesFor(tx, ctx, capabilityId, `${impact.name} was deleted`, at);
    // The rules elsewhere that hand work into it stop: each capability whose file has one gets a version without it.
    const loaded = await load(tx);
    for (const other of loaded.files.values()) {
      const gone = other.file.rules.filter((r) => r.actions.some((a) => "target" in a && a.target.capability === capabilityId));
      if (!gone.length) continue;
      const file = { ...other.file, rules: other.file.rules.filter((r) => !gone.includes(r)) };
      await saveVersion(tx, ctx, other.id, file, { source: "customize", at, event: "customize.saved", details: { change: `${impact.name} was deleted, so its connections stop` } });
    }
    await record(tx, ctx, {
      who: ctx.actor.email,
      capabilityId,
      event: "capability.deleted",
      details: { name: impact.name, ...Object.fromEntries(impact.sheets.map((s) => [s.row.many, s.count])), files: impact.files },
      at,
    });
    return impact;
  });
}

// Whether the workspace has any capability yet (3a's first heading and chips until it does).
export async function hasCapabilities(tx: Tx): Promise<boolean> {
  const [row] = await tx.select({ id: capabilities.id }).from(capabilities).where(isNull(capabilities.deletedAt)).limit(1);
  return !!row;
}

// Every capability's name, deleted ones too, for the Audit log's capability filter.
export async function capabilityNames(tx: Tx): Promise<{ id: string; name: string }[]> {
  return tx.select({ id: capabilities.id, name: capabilities.name }).from(capabilities).orderBy(capabilities.position);
}
