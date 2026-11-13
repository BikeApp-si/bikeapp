import { forgetSetup } from "./setup-cache";
import { eq } from "drizzle-orm";
import { people } from "@/db/schema";
import { parseCsv } from "@/lib/csv";
import { record } from "./audit";
import type { Ctx, Tx } from "./tx";

// The team CSV (developer notes §4). Team is optional; without it, teams come from the manager chain.
export const TEAM_CSV_HEADERS = ["Full name", "Work email", "Job title", "Team", "Manager email", "Start date"] as const;

export type PersonInput = {
  name: string;
  email: string;
  title?: string | null;
  team?: string | null;
  managerEmail?: string | null;
  startDate?: string | null; // YYYY-MM-DD
  isAdmin?: boolean;
  setupRole?: string | null; // Founder, Team lead, Ops, Finance or Member (setup 2e)
};

export type ImportCheck = {
  rows: PersonInput[];
  problems: string[]; // rows left out, in plain words
  questions: string[]; // things to ask before saving (ambiguous dates)
  flagged: string[]; // rows kept with a manager who isn't in the file
  otherHeaders: string[]; // headers for the import mapping (prompt 2b, M5)
  teamsDerived: boolean; // true when the file had no Team column (shown on 2e for the admin to change)
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isRealDate(iso: string) {
  const m = ISO_DATE.exec(iso);
  if (!m) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() + 1 === Number(m[2]) && d.getUTCDate() === Number(m[3]);
}

// Reads a team CSV and checks it. Nothing is saved; the person sees a preview and a count first.
export function checkTeamCsv(text: string): ImportCheck {
  return checkTeamRows(parseCsv(text));
}

// The same check over rows already read (a CSV or an xlsx), the first row the header.
export function checkTeamRows(table: string[][]): ImportCheck {
  const [header, ...lines] = table;
  const result: ImportCheck = { rows: [], problems: [], questions: [], flagged: [], otherHeaders: [], teamsDerived: false };
  if (!header) {
    result.problems.push("The file is empty.");
    return result;
  }
  const names = header.map((h) => h.trim());
  const col = (h: string) => names.findIndex((n) => n.toLowerCase() === h.toLowerCase());
  const idx = Object.fromEntries(TEAM_CSV_HEADERS.map((h) => [h, col(h)])) as Record<(typeof TEAM_CSV_HEADERS)[number], number>;
  if (idx["Full name"] < 0 || idx["Work email"] < 0) {
    result.problems.push("The first row needs the headers Full name and Work email.");
    return result;
  }
  result.otherHeaders = names.filter((n) => n && !TEAM_CSV_HEADERS.some((h) => h.toLowerCase() === n.toLowerCase()));

  const get = (line: string[], h: (typeof TEAM_CSV_HEADERS)[number]) => (idx[h] >= 0 ? (line[idx[h]] ?? "").trim() : "");
  const seen = new Set<string>();

  lines.forEach((line, i) => {
    const rowNo = i + 2;
    const name = get(line, "Full name");
    const email = get(line, "Work email").toLowerCase();
    const startDate = get(line, "Start date");
    if (!name || !email) return void result.problems.push(`Row ${rowNo} has no name or no work email.`);
    if (!EMAIL.test(email)) return void result.problems.push(`Row ${rowNo}: ${email} isn't an email address.`);
    if (seen.has(email)) return void result.problems.push(`Row ${rowNo}: ${email} is already in the file, so this row is left out.`);
    if (startDate && !isRealDate(startDate)) {
      result.questions.push(`Row ${rowNo}: what date is “${startDate}” for ${name}? Please write it as YYYY-MM-DD.`);
    }
    seen.add(email);
    result.rows.push({
      name,
      email,
      title: get(line, "Job title") || null,
      team: get(line, "Team") || null,
      managerEmail: get(line, "Manager email").toLowerCase() || null,
      startDate: startDate && isRealDate(startDate) ? startDate : null,
    });
  });

  for (const r of result.rows) {
    if (r.managerEmail && !seen.has(r.managerEmail)) result.flagged.push(`${r.name}: manager ${r.managerEmail} isn't in the file.`);
  }
  if (idx["Team"] < 0) {
    result.rows = deriveTeams(result.rows);
    result.teamsDerived = true;
  }
  return result;
}

const LEADERSHIP = "Leadership";

// "Engineering lead" → "Engineering", "Head of Sales" → "Sales", "Accountant, part time" → "Accountant".
export function teamFromTitle(title: string | null | undefined): string | null {
  const words = (title ?? "")
    .split(",")[0]!
    .replace(/\b(lead|leader|head|manager|director|vp|chief|of)\b/gi, " ")
    .trim()
    .replace(/\s+/g, " ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

// Teams from the manager chain: the founder (no manager) is in Leadership; each lead who reports to the
// founder starts a team named from their title; everyone else joins their lead's team. A broken chain
// (a manager who isn't in the file, or a loop) leaves the team empty for the admin to fill in on 2e.
export function deriveTeams(rows: PersonInput[]): PersonInput[] {
  const byEmail = new Map(rows.map((r) => [r.email.toLowerCase(), r]));
  const isFounder = (r: PersonInput) => !r.managerEmail;

  function teamOf(r: PersonInput): string | null {
    if (isFounder(r)) return LEADERSHIP;
    const seen = new Set<string>();
    let current = r;
    for (;;) {
      const manager = byEmail.get(current.managerEmail!.toLowerCase());
      if (!manager || seen.has(manager.email)) return null;
      if (isFounder(manager)) return teamFromTitle(current.title) ?? current.name;
      seen.add(manager.email);
      current = manager;
    }
  }

  return rows.map((r) => ({ ...r, team: teamOf(r) }));
}

// Saves people in one transaction with one Audit entry. Managers are matched by email within the file and
// the workspace's People; a manager who isn't found keeps the row and is flagged.
export async function importPeople(tx: Tx, ctx: Ctx, by: string, rows: PersonInput[], source: string, at?: Date) {
  const existing = await tx.select({ id: people.id, email: people.email }).from(people).where(eq(people.workspaceId, ctx.workspaceId));
  const ids = new Map(existing.map((p) => [p.email.toLowerCase(), p.id]));
  const fresh = rows.filter((r) => !ids.has(r.email.toLowerCase()));

  const inserted = fresh.length
    ? await tx
        .insert(people)
        .values(
          fresh.map((r) => ({
            workspaceId: ctx.workspaceId,
            name: r.name,
            email: r.email.toLowerCase(),
            title: r.title ?? null,
            team: r.team ?? null,
            startDate: r.startDate ?? null,
            isAdmin: r.isAdmin ?? false,
            setupRole: r.setupRole ?? null,
          })),
        )
        .returning({ id: people.id, email: people.email })
    : [];
  forgetSetup();
  for (const p of inserted) ids.set(p.email, p.id);

  let flagged = 0;
  for (const r of fresh) {
    if (!r.managerEmail) continue;
    const managerId = ids.get(r.managerEmail.toLowerCase());
    const id = ids.get(r.email.toLowerCase())!;
    if (managerId) await tx.update(people).set({ managerId }).where(eq(people.id, id));
    else {
      flagged++;
      await tx.update(people).set({ managerFlag: r.managerEmail }).where(eq(people.id, id));
    }
  }
  forgetSetup();

  await record(tx, ctx, {
    who: by,
    event: "people.imported",
    details: { source, added: inserted.length, skipped: rows.length - fresh.length, managerNotFound: flagged },
    at,
  });
  return { added: inserted.length, skipped: rows.length - fresh.length, flagged };
}
