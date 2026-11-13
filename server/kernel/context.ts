import { cachedSetup } from "./setup-cache";
import { and, desc, eq, isNull } from "drizzle-orm";
import { capabilities, capabilityVersions, companyRules, people, workspaces } from "@/db/schema";
import type { AuditInput } from "./audit";
import { companyRuleSet, ruleSet, type RuleEntry } from "./rule-set";
import type { CapabilityFile } from "./schema/file";
import type { CompanyRule } from "./schema/company";
import type { Tx } from "./tx";
import { currentTime } from "./clock";
import { formatsOf, type Formats } from "@/lib/format";

// Who is doing something, as the kernel needs it: the workspace, the person and the time.
export type Actor = { id: string; email: string };
export type KernelCtx = { workspaceId: string; actor: Actor; now?: Date };

export type Person = { id: string; name: string; email: string; managerId: string | null; isAdmin: boolean };
export type CurrentFile = { id: string; version: number; file: CapabilityFile; ownerId: string | null };

// What one kernel call reads once and uses throughout: People, the time zone, every current file and the
// rules the kernel runs (rule-set.ts).
export type Loaded = {
  people: Map<string, Person>;
  timeZone: string;
  formats: Formats; // how the company writes money, numbers and dates (M26)
  files: Map<string, CurrentFile>;
  // The company's rules (0.2), current version; null before any is saved.
  company: { version: number; rules: CompanyRule[] } | null;
  rules: RuleEntry[];
};

export function load(tx: Tx): Promise<Loaded> {
  return cachedSetup(() => readSetup(tx));
}

async function readSetup(tx: Tx): Promise<Loaded> {
  const [ws] = await tx
    .select({ timeZone: workspaces.timeZone, currency: workspaces.currency, numberGrouping: workspaces.numberGrouping, dateStyle: workspaces.dateStyle, fiscalYearStart: workspaces.fiscalYearStart })
    .from(workspaces);
  const ps = await tx
    .select({ id: people.id, name: people.name, email: people.email, managerId: people.managerId, isAdmin: people.isAdmin })
    .from(people);
  const fs = await tx
    .select({ id: capabilities.id, version: capabilities.currentVersion, ownerId: capabilities.ownerId, file: capabilityVersions.file })
    .from(capabilities)
    .innerJoin(capabilityVersions, and(eq(capabilityVersions.capabilityId, capabilities.id), eq(capabilityVersions.version, capabilities.currentVersion)))
    .where(isNull(capabilities.deletedAt));
  const files = new Map(fs.map((f) => [f.id, { id: f.id, version: f.version, ownerId: f.ownerId, file: f.file as CapabilityFile }]));
  const [cr] = await tx.select({ version: companyRules.version, rules: companyRules.rules }).from(companyRules).orderBy(desc(companyRules.version)).limit(1);
  const company = cr ? { version: cr.version, rules: cr.rules as CompanyRule[] } : null;
  // Company rules on a capability that is gone (or not visible) are left out.
  const rules = [...ruleSet(files), ...companyRuleSet(company).filter((e) => files.has(e.capabilityId))];
  return { people: new Map(ps.map((p) => [p.id, p])), timeZone: ws?.timeZone ?? "UTC", formats: formatsOf(ws ?? {}), files, company, rules };
}

// How the company writes money, numbers and dates, without the rest of `load` (the signed-in frame, M26).
export async function workspaceFormats(tx: Tx): Promise<Formats> {
  const [ws] = await tx
    .select({ currency: workspaces.currency, numberGrouping: workspaces.numberGrouping, dateStyle: workspaces.dateStyle, fiscalYearStart: workspaces.fiscalYearStart })
    .from(workspaces);
  return formatsOf(ws ?? {});
}

// Today's date (YYYY-MM-DD) in the workspace's time zone.
export function todayIn(timeZone: string, now = currentTime()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// A person and everyone below them in the manager chain, from People. Worked out once per People snapshot and
// person: access checks ask for it on every row (M12).
const teams = new WeakMap<Map<string, Person>, Map<string, Set<string>>>();

export function teamOf(personId: string, ps: Map<string, Person>): Set<string> {
  let known = teams.get(ps);
  if (!known) teams.set(ps, (known = new Map()));
  const hit = known.get(personId);
  if (hit) return hit;
  const team = walkTeam(personId, ps);
  known.set(personId, team);
  return team;
}

function walkTeam(personId: string, ps: Map<string, Person>): Set<string> {
  const team = new Set([personId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of ps.values()) {
      if (p.managerId && team.has(p.managerId) && !team.has(p.id)) {
        team.add(p.id);
        grew = true;
      }
    }
  }
  return team;
}

export class KernelError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [message],
  ) {
    super(message);
  }
}

// Refused for lack of access. The message never says what exists that the person can't see.
export class AccessError extends KernelError {}

// One kernel call's working state: its transaction, who is acting, what it loaded and today's date.
export type Work = {
  tx: Tx;
  ctx: KernelCtx;
  loaded: Loaded;
  today: string;
  now: Date;
  // Entries rules leave for after the write's own entry (rules.ts).
  after: AuditInput[];
};

export async function startWork(tx: Tx, ctx: KernelCtx): Promise<Work> {
  const loaded = await load(tx);
  const now = ctx.now ?? currentTime();
  return { tx, ctx, loaded, now, today: todayIn(loaded.timeZone, now), after: [] };
}
