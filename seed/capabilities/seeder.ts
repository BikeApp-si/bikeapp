// Helpers for seeding capabilities through the kernel, at the times the screens show. Everything runs in the
// caller's one transaction, so a seed that fails leaves nothing behind.
//
// The daily job is replayed day by day: before each dated step, a capability's 06:00 runs (in the workspace's
// time zone) are caught up to that time, so every rule run and the move it makes are dated when they would
// really have happened. The seed ends with the run of the day the screens assume (TODAY).
import { and, eq, isNull } from "drizzle-orm";
import { people, uploads, waits, workspaces } from "@/db/schema";
import { createCapability, saveVersion } from "@/server/kernel/capabilities";
import { todayIn, type KernelCtx } from "@/server/kernel/context";
import { runDateRules, systemCtx } from "@/server/kernel/date-rules";
import { createRow, importRows, moveStep, type NewRow } from "@/server/kernel/rows";
import { decide } from "@/server/kernel/waiting";
import type { CapabilityFile } from "@/server/kernel/schema/file";
import type { Tx } from "@/server/kernel/tx";

export type Seeder = Awaited<ReturnType<typeof seeder>>;

// The day the screens assume: the seed's last daily run is at 06:00 that morning.
export const TODAY = "2026-10-27";

// 06:00 on a day, in a time zone, as an instant.
export function sixAm(day: string, timeZone: string): Date {
  const guess = new Date(`${day}T06:00:00Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(guess)
      .map((p) => [p.type, p.value]),
  );
  const shown = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!);
  return new Date(guess.getTime() - (shown - guess.getTime()));
}

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export async function seeder(tx: Tx, workspaceId: string) {
  const all = await tx.select({ id: people.id, email: people.email }).from(people);
  const byEmail = new Map(all.map((p) => [p.email, p.id]));
  const [ws] = await tx.select({ timeZone: workspaces.timeZone }).from(workspaces);
  const timeZone = ws!.timeZone;

  // The last daily run replayed for each capability (its creation, to begin with).
  const ranTo = new Map<string, Date>();
  async function catchUp(capId: string, until: Date) {
    const from = ranTo.get(capId);
    if (!from) return;
    for (let day = todayIn(timeZone, from); ; day = nextDay(day)) {
      const at = sixAm(day, timeZone);
      if (at > until) break;
      if (at <= from) continue;
      await runDateRules(tx, systemCtx(workspaceId, at), { capabilityId: capId });
      ranTo.set(capId, at);
    }
  }

  // A person's id from their Fernwood address ("maya" → maya@fernwood.dev).
  const p = (name: string) => {
    const id = byEmail.get(`${name}@fernwood.dev`);
    if (!id) throw new Error(`No ${name}@fernwood.dev in People`);
    return id;
  };
  const ctx = (name: string, at: string): KernelCtx => ({ workspaceId, actor: { id: p(name), email: `${name}@fernwood.dev` }, now: new Date(at) });
  const run = <T>(name: string, at: string, fn: (tx: Tx, c: KernelCtx) => Promise<T>) => fn(tx, ctx(name, at));

  // Each dated step first catches its capability's daily runs up to its time.
  const dated = async <T>(capId: string, at: string, fn: () => Promise<T>) => {
    await catchUp(capId, new Date(at));
    return fn();
  };
  const capOfRow = async (rowId: string) => (await tx.query.rows.findFirst({ where: (r, { eq }) => eq(r.id, rowId), columns: { capabilityId: true } }))!.capabilityId;

  return {
    p,
    create: async (file: CapabilityFile, at: string, opts: { owner: string; source?: "plan" | "build" }) => {
      const { id } = await run("wade", at, (tx, c) => createCapability(tx, c, file, { source: opts.source ?? "build", at: new Date(at), ownerId: p(opts.owner) }));
      ranTo.set(id, new Date(at));
      return id;
    },
    // A later version, written as a Customize change.
    change: (capId: string, file: CapabilityFile, at: string, change: string) =>
      dated(capId, at, () => run("wade", at, (tx, c) => saveVersion(tx, c, capId, file, { source: "customize", at: new Date(at), event: "customize.saved", details: { change } }))),
    import: (capId: string, sheet: string, rows: NewRow[], source: string, at: string, details?: Record<string, unknown>) =>
      dated(capId, at, () => run("wade", at, (tx, c) => importRows(tx, c, capId, sheet, rows, { source, at: new Date(at), details }))),
    // A row added by hand, by that person.
    add: (name: string, capId: string, sheet: string, values: Record<string, unknown>, at: string, parentRowId?: string) =>
      dated(capId, at, () => run(name, at, (tx, c) => createRow(tx, c, capId, sheet, { values, parentRowId })).then((r) => r.id)),
    move: async (name: string, rowId: string, step: string, at: string) => dated(await capOfRow(rowId), at, () => run(name, at, (tx, c) => moveStep(tx, c, rowId, step))),
    // That person approves or declines what a rule asked them to decide about this row.
    decide: async (name: string, rowId: string, ruleId: string, choice: "approve" | "decline", at: string) =>
      dated(await capOfRow(rowId), at, async () => {
        const [w] = await tx.select({ id: waits.id }).from(waits).where(and(eq(waits.rowId, rowId), eq(waits.ruleId, ruleId), isNull(waits.clearedAt)));
        if (!w) throw new Error(`Nothing from ${ruleId} waits on that row`);
        return run(name, at, (tx, c) => decide(tx, c, w.id, choice));
      }),
    // The daily runs of every capability, up to 06:00 on TODAY.
    toToday: async () => {
      for (const capId of ranTo.keys()) await catchUp(capId, sixAm(TODAY, timeZone));
    },
    // A file's record (the screens name it); the bytes come with uploads in a later milestone.
    upload: (name: string, by: string, at: string) =>
      tx
        .insert(uploads)
        .values({ workspaceId, key: `workspaces/${workspaceId}/seed/${name}`, name, mime: "application/pdf", size: 180_000, uploadedBy: p(by), createdAt: new Date(at) })
        .returning({ id: uploads.id })
        .then((r) => r[0]!.id),
  };
}
