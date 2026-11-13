import { forgetSetup } from "./setup-cache";
import { count, eq, sql } from "drizzle-orm";
import { capabilities, people } from "@/db/schema";
import { checkTeamCsv, importPeople } from "./people";
import { accessTo } from "./access";
import { record } from "./audit";
import { KernelError, load, todayIn, type KernelCtx } from "./context";
import { mustBeAdmin } from "./admin";
import { checkNewPerson, type NewPerson } from "./directory-rules";
import { withWorkspace, type Tx } from "./tx";
import { currentTime } from "./clock";

// People (7f, 7g): everyone in the workspace sees the list. Adding people is for admins; it sends no email
// and gives no roles (they sign in with an email code when they're ready).

// The People count in the sidebar header and on the People item.
export async function peopleCount(workspaceId: string, personId: string): Promise<number> {
  return withWorkspace({ workspaceId, personId }, async (tx) => {
    const [row] = await tx.select({ n: count() }).from(people);
    return row?.n ?? 0;
  });
}

export type PersonRow = {
  id: string;
  name: string;
  email: string;
  title: string | null;
  team: string | null;
  manager: { id: string; name: string } | null;
  noManager: boolean; // the import named a manager who isn't in People
  startDate: string | null;
  isAdmin: boolean;
};

// Everyone, in the order they were added: the founder, then the team as the file listed it.
export async function listPeople(tx: Tx, opts: { search?: string; team?: string } = {}): Promise<PersonRow[]> {
  const all = await tx.select().from(people).orderBy(people.seq);
  const byId = new Map(all.map((p) => [p.id, p]));
  const q = opts.search?.trim().toLowerCase();
  return all
    .filter((p) => !opts.team || p.team === opts.team)
    .filter((p) => !q || [p.name, p.email, p.title ?? "", p.team ?? ""].some((v) => v.toLowerCase().includes(q)))
    .map((p) => {
      const m = p.managerId ? byId.get(p.managerId) : undefined;
      return {
        id: p.id,
        name: p.name,
        email: p.email,
        title: p.title,
        team: p.team,
        manager: m ? { id: m.id, name: m.name } : null,
        noManager: !m && !!p.managerFlag,
        startDate: p.startDate,
        isAdmin: p.isAdmin,
      };
    });
}

export async function teamsOf(tx: Tx): Promise<string[]> {
  const rows = await tx.selectDistinct({ team: people.team }).from(people);
  return rows.map((r) => r.team).filter((t): t is string => !!t).sort();
}

// The roles a person holds, as "Requesters in Spend", in the sidebar's order (7g). Only in capabilities the
// one asking can see: an employee never learns of a capability hidden from them through someone's roles.
export async function rolesOf(tx: Tx, ctx: KernelCtx, personId: string): Promise<string[]> {
  const loaded = await load(tx);
  const order = await tx.select({ id: capabilities.id }).from(capabilities).orderBy(capabilities.position);
  const hasReports = [...loaded.people.values()].some((p) => p.managerId === personId);
  const viewerIsAdmin = !!loaded.people.get(ctx.actor.id)?.isAdmin;
  const out: string[] = [];
  for (const { id } of order) {
    if (!viewerIsAdmin) {
      // As the sidebar decides (capabilitiesFor): some role lets them see one of its sheets.
      const mine = await accessTo(tx, loaded, id, ctx.actor.id);
      if (!mine?.cap.file.sheets.some((s) => mine.can("see", s.id))) continue;
    }
    const access = await accessTo(tx, loaded, id, personId);
    if (!access) continue;
    for (const r of access.roles) {
      // A role everyone holds is listed only when it gives this person something of their own:
      // adding rows, or (scoped to a team) people under them.
      if (r.members.kind === "everyone" && !r.can.includes("add") && !(r.scope === "team" && hasReports)) continue;
      out.push(`${r.name} in ${access.cap.file.name}`);
    }
  }
  return out;
}

export { checkNewPerson, type NewPerson } from "./directory-rules";

export async function addPerson(tx: Tx, ctx: KernelCtx, input: NewPerson) {
  await mustBeAdmin(tx, ctx);
  const errors = checkNewPerson(input);
  const first = Object.values(errors)[0];
  if (first) throw new KernelError(first, Object.values(errors));
  const email = input.email.trim().toLowerCase();
  const [taken] = await tx.select({ id: people.id }).from(people).where(sql`lower(${people.email}) = ${email}`);
  if (taken) throw new KernelError("Someone in People already has that email.");
  if (input.managerId) {
    const [m] = await tx.select({ id: people.id }).from(people).where(eq(people.id, input.managerId));
    if (!m) throw new KernelError("The manager must be someone in People.");
  }
  const [p] = await tx
    .insert(people)
    .values({
      workspaceId: ctx.workspaceId,
      name: input.name.trim(),
      email,
      title: input.title?.trim() || null,
      team: input.team?.trim() || null,
      managerId: input.managerId || null,
      startDate: input.startDate || null,
      ...(ctx.now ? { createdAt: ctx.now } : {}),
    })
    .returning({ id: people.id });
  forgetSetup();
  await record(tx, ctx, { who: ctx.actor.email, event: "person.added", details: { person: email, name: input.name.trim() }, at: ctx.now });
  return { id: p!.id };
}

// Import CSV on 7f: the team CSV rules, all or nothing. A file with problems or questions saves nobody.
export async function importPeopleCsv(tx: Tx, ctx: KernelCtx, file: { name: string; text: string }) {
  await mustBeAdmin(tx, ctx);
  const check = checkTeamCsv(file.text);
  const blocking = [...check.problems, ...check.questions];
  if (blocking.length) throw new KernelError(blocking[0]!, blocking);
  if (!check.rows.length) throw new KernelError("The file has nobody in it.");
  return importPeople(tx, ctx, ctx.actor.email, check.rows, file.name, ctx.now);
}

// Today in the workspace, for tenure and the time now (7g).
export async function workspaceToday(tx: Tx, now = currentTime()) {
  const { timeZone } = await load(tx);
  return { today: todayIn(timeZone, now), timeZone };
}
