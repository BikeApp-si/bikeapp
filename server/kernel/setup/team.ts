import { forgetSetup } from "../setup-cache";
import { eq } from "drizzle-orm";
import { people, workspaces } from "@/db/schema";
import { importPeople, type ImportCheck, type PersonInput } from "../people";
import { mustBeAdmin } from "../admin";
import { KernelError, type KernelCtx } from "../context";
import type { Tx } from "../tx";

// Setup's team (2d → 2e): people from a file or from prompt 8's reading, checked here, with setup roles from
// fixed rules (never from the model). Nothing is saved until Finish setup.

export const SETUP_ROLES = ["Founder", "Team lead", "Ops", "Finance", "Member"] as const;
export type SetupRole = (typeof SETUP_ROLES)[number];

// One person as setup holds them. `manager` is another person's key (their email, or their name while
// they have none); `managerOutside` is a manager email from a file that isn't in it.
export type TeamPerson = {
  key: string;
  name: string;
  email: string | null;
  title: string | null;
  team: string | null;
  manager: string | null;
  managerOutside?: string | null;
  managerUnknown?: boolean; // a manager was named but isn't in the team: not a founder
  startDate?: string | null;
  role: SetupRole;
};

export type TeamDraft = { people: TeamPerson[]; problems: string[]; file: string | null };

// What prompt 8 returns for the team (no roles: the kernel sets them).
export type TeamReading = {
  people: { name: string; email: string | null; title: string | null; manager: string | null; team: string | null }[];
  teams: string[];
  problems: string[];
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OPS = /\b(operations|office)\b/i;
const IT = /\bIT\b/; // capitals only, so "it" in a title isn't IT
const FINANCE = /financ|accountant/i;

// Developer notes §4, first match wins: no manager → Founder; operations, office or IT in the title → Ops;
// finance or accountant → Finance; people report to them → Team lead; everyone else → Member.
export function setupRoles<P extends Omit<TeamPerson, "role">>(list: P[]): (P & { role: SetupRole })[] {
  const managers = new Set(list.map((p) => p.manager).filter(Boolean));
  return list.map((p) => {
    const title = p.title ?? "";
    const role: SetupRole =
      !p.manager && !p.managerOutside && !p.managerUnknown ? "Founder" : OPS.test(title) || IT.test(title) ? "Ops" : FINANCE.test(title) ? "Finance" : managers.has(p.key) ? "Team lead" : "Member";
    return { ...p, role };
  });
}

// A team file that passed the CSV rules, as setup holds it.
export function draftFromFile(check: ImportCheck, file: string): TeamDraft {
  const inFile = new Set(check.rows.map((r) => r.email));
  const list = check.rows.map((r) => ({
    key: r.email,
    name: r.name,
    email: r.email,
    title: r.title ?? null,
    team: r.team ?? null,
    manager: r.managerEmail && inFile.has(r.managerEmail) ? r.managerEmail : null,
    managerOutside: r.managerEmail && !inFile.has(r.managerEmail) ? r.managerEmail : null,
    startDate: r.startDate ?? null,
  }));
  return { people: setupRoles(list), problems: [...check.problems, ...check.questions, ...check.flagged], file };
}

// Prompt 8's reading, checked. An email counts only when it appears exactly in what the admin wrote or in
// the file (`said`); any other email is treated as missing and asked about. Start dates come from `known`.
export function draftFromReading(r: TeamReading, said: string, known: TeamPerson[], file: string | null): TeamDraft {
  const problems = r.problems.filter((p) => p.trim());
  const text = said.toLowerCase();
  const knownByEmail = new Map(known.filter((k) => k.email).map((k) => [k.email!, k]));
  const seen = new Set<string>();
  const list: Omit<TeamPerson, "role">[] = [];
  for (const p of r.people) {
    const name = p.name.trim();
    if (!name) continue;
    let email = p.email?.trim().toLowerCase() || null;
    if (email && (!EMAIL.test(email) || !text.includes(email))) email = null;
    const key = email ?? name;
    if (seen.has(key.toLowerCase())) {
      problems.push(`${name} is in the team twice, so I kept the first.`);
      continue;
    }
    seen.add(key.toLowerCase());
    if (!email) problems.push(`What is ${name}'s work email?`);
    list.push({ key, name, email, title: p.title?.trim() || null, team: p.team?.trim() || null, manager: p.manager?.trim() || null, startDate: email ? (knownByEmail.get(email)?.startDate ?? null) : null });
  }
  // A manager is named by email or by name, and must be someone in the team.
  const byEmail = new Map(list.filter((p) => p.email).map((p) => [p.email!, p.key]));
  const byName = new Map(list.map((p) => [p.name.toLowerCase(), p.key]));
  for (const p of list) {
    if (!p.manager) continue;
    const m = byEmail.get(p.manager.toLowerCase()) ?? byName.get(p.manager.toLowerCase()) ?? null;
    if (!m || m === p.key) {
      problems.push(`${p.name}'s manager ${p.manager} isn't in the team, so I left it empty.`);
      p.managerUnknown = true;
    }
    p.manager = m && m !== p.key ? m : null;
  }
  return { people: setupRoles(list), problems: [...new Set(problems)], file };
}

// 2e's table: the founder and the people who report to the founder, each with how many of the others report
// to them (so the reports add up to "the other 9").
export function leadsTable(d: TeamDraft) {
  const founders = new Set(d.people.filter((p) => p.role === "Founder").map((p) => p.key));
  const leads = d.people.filter((p) => founders.has(p.key) || (p.manager && founders.has(p.manager)));
  const isLead = new Set(leads.map((p) => p.key));
  const reports = (key: string) => d.people.filter((p) => p.manager === key && !isLead.has(p.key)).length;
  return { leads: leads.map((p) => ({ key: p.key, name: p.name, title: p.title, reports: reports(p.key), role: p.role })), others: d.people.length - leads.length };
}

// Finish setup: everyone with an email goes into People with one people.imported entry. People without one
// are left out; anyone whose manager was left out is saved with no manager. The owner, already in People,
// gets their title, team, manager and role from the team.
export async function finishTeam(tx: Tx, ctx: KernelCtx, d: TeamDraft) {
  await mustBeAdmin(tx, ctx);
  const [ws] = await tx.select({ ownerId: workspaces.ownerId }).from(workspaces);
  if (!ws) throw new KernelError("No workspace.");
  const [owner] = await tx.select({ email: people.email }).from(people).where(eq(people.id, ws.ownerId!));
  const byKey = new Map(d.people.map((p) => [p.key, p]));
  const saved = d.people.filter((p) => p.email);
  const leftOut = d.people.filter((p) => !p.email).map((p) => p.name);
  const noManager: string[] = [];
  const managerEmailOf = (p: TeamPerson) => {
    if (p.managerOutside) return p.managerOutside;
    if (!p.manager) return null;
    const m = byKey.get(p.manager);
    if (!m?.email) {
      noManager.push(p.name);
      return null;
    }
    return m.email;
  };
  const rows: PersonInput[] = saved.map((p) => ({ name: p.name, email: p.email!, title: p.title, team: p.team, managerEmail: managerEmailOf(p), startDate: p.startDate ?? null, setupRole: p.role }));
  const result = await importPeople(tx, ctx, ctx.actor.email, rows, d.file ? "setup:file" : "setup", ctx.now);

  const me = rows.find((r) => r.email.toLowerCase() === owner?.email.toLowerCase());
  if (me) {
    const [manager] = me.managerEmail ? await tx.select({ id: people.id }).from(people).where(eq(people.email, me.managerEmail.toLowerCase())) : [];
    await tx
      .update(people)
      .set({ title: me.title ?? null, team: me.team ?? null, startDate: me.startDate ?? null, setupRole: me.setupRole ?? null, managerId: manager?.id ?? null })
      .where(eq(people.id, ws.ownerId!));
    forgetSetup();
  }
  return { ...result, leftOut, noManager };
}

// 2f's "14 people · 5 teams · 5 roles", from People as saved.
export async function teamSummary(tx: Tx) {
  const all = await tx.select({ team: people.team, role: people.setupRole }).from(people);
  const distinct = (xs: (string | null)[]) => new Set(xs.filter((x): x is string => !!x)).size;
  return { people: all.length, teams: distinct(all.map((p) => p.team)), roles: distinct(all.map((p) => p.role)) };
}
