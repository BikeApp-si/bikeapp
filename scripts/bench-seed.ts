// The kernel study's company (M11): Fernwood grown to about 100,000 rows in its own local database, bike_bench,
// so the bench measures Bike at the size a larger company reaches. Never on production: localhost only.
// Usage: pnpm bench:seed [--rows 100000]
//
// It starts from the real seed (six capabilities, their rules, roles and history), then copies the whole company
// in SQL as many times as needed: each copy gets new ids, points its links, lines and waits at its own rows, and
// spreads its people over a staff of 200 in a manager chain. Totals and other stored computed values stay right,
// because every copy holds the rows they add up. Going through the kernel row by row would take hours, and the
// kernel is what is being measured.
import { randomUUID } from "node:crypto";
import postgres from "postgres";

type Sql = postgres.Sql;
const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function mustBeLocal(url: string) {
  if (!LOCAL.has(new URL(url).hostname)) throw new Error(`The bench only runs against a database on localhost, not ${new URL(url).hostname}.`);
}

// Any id in a value that belongs to the copied company becomes its copy's id.
function remap(v: unknown, map: (id: string) => string | undefined): unknown {
  if (typeof v === "string") return UUID.test(v) ? (map(v) ?? v) : v;
  if (Array.isArray(v)) return v.map((x) => remap(x, map));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remap(x, map)]));
  return v;
}

async function inBatches<T>(list: T[], size: number, fn: (part: T[]) => Promise<unknown>) {
  for (let i = 0; i < list.length; i += size) await fn(list.slice(i, i + size));
}

export type Grown = { copies: number; rows: number; people: number; audit: number; waits: number; ruleRuns: number };

// Grows one workspace to about `target` live rows and `staff` people. As the database owner (no row-level
// security on a local superuser), so it writes in bulk.
export async function grow(sql: Sql, workspaceId: string, target: number, staff = 200): Promise<Grown> {
  const src = await sql`select * from rows where workspace_id = ${workspaceId} and deleted_at is null order by seq`;
  const copies = Math.max(0, Math.ceil(target / src.length) - 1);

  // People: up to `staff`, each new one reporting to someone earlier, four to a manager, so teams nest.
  const before = await sql`select id from people where workspace_id = ${workspaceId} order by seq`;
  const ids = before.map((p) => p.id as string);
  const teams = ["Engineering", "Sales", "Operations", "Finance", "Design"];
  const added: Record<string, unknown>[] = [];
  for (let i = ids.length; i < staff; i++) {
    const id = randomUUID();
    added.push({ id, workspace_id: workspaceId, name: `Bench Person ${i}`, email: `person${i}@bench.test`, title: "Member", team: teams[i % teams.length], manager_id: ids[Math.floor((i - 1) / 4)] ?? null });
    ids.push(id);
  }
  await inBatches(added, 500, (part) => sql`insert into people ${sql(part)}`);
  const index = new Map(ids.map((id, i) => [id, i]));

  const waits = await sql`select * from waits where workspace_id = ${workspaceId}`;
  const runs = await sql`select * from rule_runs where workspace_id = ${workspaceId}`;
  const audit = await sql`select * from audit_entries where workspace_id = ${workspaceId} order by seq`;
  const emailOf = new Map((await sql`select id, email from people where workspace_id = ${workspaceId}`).map((p) => [p.id as string, p.email as string]));

  for (let c = 1; c <= copies; c++) {
    const rowMap = new Map(src.map((r) => [r.id as string, randomUUID()]));
    // Each copy hands its people's places to others on the staff, so own and team scopes spread out.
    const person = (id: string) => (index.has(id) ? ids[(index.get(id)! + c * 13) % ids.length] : undefined);
    const map = (id: string) => rowMap.get(id) ?? person(id);
    const shift = (d: Date) => new Date(d.getTime() - c * 3600_000);

    const copied = src.map((r) => ({
      id: rowMap.get(r.id)!,
      workspace_id: workspaceId,
      capability_id: r.capability_id,
      sheet_id: r.sheet_id,
      data: sql.json(remap(r.data, map) as postgres.JSONValue),
      step_id: r.step_id,
      file_version: r.file_version,
      parent_row_id: r.parent_row_id ? (rowMap.get(r.parent_row_id) ?? null) : null,
      created_by: r.created_by ? (person(r.created_by) ?? null) : null,
      created_at: shift(r.created_at),
      updated_at: shift(r.updated_at),
    }));
    // Documents come before their lines (seq order), and a statement checks its own references at its end.
    await inBatches(copied, 1000, (part) => sql`insert into rows ${sql(part)}`);

    const copiedWaits = waits
      .filter((w) => rowMap.has(w.row_id))
      .map(({ id: _id, ...w }) => ({ ...w, row_id: rowMap.get(w.row_id)!, person_id: person(w.person_id) ?? w.person_id, decided_by: w.decided_by ? (person(w.decided_by) ?? null) : null, decision: w.decision ? sql.json(w.decision) : null, created_at: shift(w.created_at) }));
    await inBatches(copiedWaits, 1000, (part) => sql`insert into waits ${sql(part)}`);

    const copiedRuns = runs.filter((r) => rowMap.has(r.row_id)).map(({ id: _id, ...r }) => ({ ...r, row_id: rowMap.get(r.row_id)!, ran_at: shift(r.ran_at) }));
    await inBatches(copiedRuns, 1000, (part) => sql`insert into rule_runs ${sql(part)}`);

    // The Audit log grows with the company: the seed's history once per copy, and an entry for each row added.
    const history = audit.map(({ id: _id, seq: _seq, ...a }) => ({
      ...a,
      details: sql.json(remap(a.details, map) as postgres.JSONValue),
      at: shift(a.at),
      row_ids: (a.row_ids as string[] | null)?.map((id) => rowMap.get(id) ?? id) ?? null,
    }));
    const created = copied.map((r) => ({
      workspace_id: workspaceId,
      at: r.created_at,
      who: emailOf.get(r.created_by ?? "") ?? "bench",
      capability_id: r.capability_id,
      event: "row.created",
      details: sql.json({ sheet: r.sheet_id }),
      who_label: null,
      change_set_id: null,
      chat_id: null,
      row_ids: [r.id],
    }));
    await inBatches([...history, ...created], 1000, (part) => sql`insert into audit_entries ${sql(part)}`);
  }
  await sql`analyze`;

  const count = async (q: postgres.PendingQuery<postgres.Row[]>) => ((await q) as unknown as [{ n: number }])[0].n;
  return {
    copies,
    rows: await count(sql`select count(*)::int as n from rows where workspace_id = ${workspaceId} and deleted_at is null`),
    people: await count(sql`select count(*)::int as n from people where workspace_id = ${workspaceId}`),
    audit: await count(sql`select count(*)::int as n from audit_entries where workspace_id = ${workspaceId}`),
    waits: await count(sql`select count(*)::int as n from waits where workspace_id = ${workspaceId}`),
    ruleRuns: await count(sql`select count(*)::int as n from rule_runs where workspace_id = ${workspaceId}`),
  };
}

// M25: a capability at every limit (Admissions: 6 sheets × 40 questions, 20 rules), made through the kernel as Wade,
// then `applications` rows written in SQL with every question filled, and as many rows again across its other five
// sheets, each linked to an application. Counsellors are spread over the staff, Maya among them, so her own rows
// are a slice.
export async function addWide(sql: Sql, workspaceId: string, applications = 10_000): Promise<number> {
  // The kernel's connection goes to bike_bench, never the dev database.
  process.env.DATABASE_URL = BENCH_DATABASE_URL();
  mustBeLocal(process.env.DATABASE_URL);
  const { closeDb } = await import("@/db/client");
  await closeDb();
  const { withWorkspace } = await import("@/server/kernel/tx");
  const { createCapability } = await import("@/server/kernel/capabilities");
  const { bigFile } = await import("@/server/kernel/fixtures");
  const [wade] = await sql`select id, email from people where workspace_id = ${workspaceId} and email = 'wade@fernwood.dev'`;
  const file = bigFile([wade!.id as string]);
  const ctx = { workspaceId, actor: { id: wade!.id as string, email: wade!.email as string } };
  const { id: capId } = await withWorkspace({ workspaceId, personId: ctx.actor.id }, (tx) => createCapability(tx, ctx, file, { source: "build" }));
  const staff = (await sql`select id from people where workspace_id = ${workspaceId} order by seq`).map((p) => p.id as string);
  const [maya] = await sql`select id from people where workspace_id = ${workspaceId} and email = 'maya@fernwood.dev'`;

  const value = (type: string, n: number): unknown => {
    switch (type) {
      case "text": return `Answer ${n}`;
      case "long_text": return `A longer answer, number ${n}, as a parent might write it.`;
      case "number": case "days": case "percent": return n % 97;
      case "money": return (n % 500) * 1000;
      case "date": return `2026-${String((n % 12) + 1).padStart(2, "0")}-${String((n % 28) + 1).padStart(2, "0")}`;
      case "datetime": return `2026-10-${String((n % 28) + 1).padStart(2, "0")}T09:00:00.000Z`;
      case "email": return `parent${n}@example.com`;
      case "phone": return `+91 98${String(n).padStart(8, "0")}`;
      case "url": return `https://example.com/${n}`;
      default: return null; // file: none attached
    }
  };
  const filled = (sheet: (typeof file.sheets)[number], n: number) =>
    Object.fromEntries(sheet.columns.filter((c) => c.id.startsWith("q")).map((c) => [c.id, value(c.type, n)]).filter(([, v]) => v !== null));
  const apps = file.sheets[0]!;
  const steps = apps.steps!.map((s) => s.id);
  const at = new Date("2026-10-27T06:00:00Z");
  const main = Array.from({ length: applications }, (_, n) => ({
    id: randomUUID(),
    workspace_id: workspaceId,
    capability_id: capId,
    sheet_id: apps.id,
    data: sql.json({ student: `Student ${n}`, grade: `g${(n % 12) + 1}`, fee: 15_000_00 + (n % 50) * 1000, applied: value("date", n), owner: n % 10 === 0 ? maya!.id : staff[n % staff.length], status: steps[n % steps.length], ...filled(apps, n) } as postgres.JSONValue),
    step_id: steps[n % steps.length], // kept in the data under the step column as well, as the kernel writes it
    file_version: 1,
    created_by: wade!.id,
    created_at: at,
    updated_at: at,
  }));
  await inBatches(main, 1000, (part) => sql`insert into rows ${sql(part)}`);
  const children = file.sheets.slice(1).flatMap((sheet, k) =>
    Array.from({ length: applications / 5 }, (_, n) => ({
      id: randomUUID(),
      workspace_id: workspaceId,
      capability_id: capId,
      sheet_id: sheet.id,
      data: sql.json({ title: `${sheet.name} ${n}`, application: main[(n * 5 + k) % main.length]!.id, ...filled(sheet, n) } as postgres.JSONValue),
      step_id: null,
      file_version: 1,
      created_by: wade!.id,
      created_at: at,
      updated_at: at,
    })),
  );
  await inBatches(children, 1000, (part) => sql`insert into rows ${sql(part)}`);
  await closeDb();
  await sql`analyze`;
  return main.length + children.length;
}

// bike_bench: the dev database's connections with the name swapped, like Playwright's bike_e2e.
function benchUrl(url: string | undefined): string {
  if (!url) throw new Error("Set DATABASE_URL and DATABASE_ADMIN_URL in .env");
  const u = new URL(url);
  u.pathname = "/bike_bench";
  return u.toString();
}
export const BENCH_DATABASE_URL = () => benchUrl(process.env.DATABASE_URL);
export const BENCH_DATABASE_ADMIN_URL = () => benchUrl(process.env.DATABASE_ADMIN_URL);

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.loadEnvFile(); } catch {}
  const i = process.argv.indexOf("--rows");
  const target = i > 0 ? Number(process.argv[i + 1]) : 100_000;
  if (!Number.isInteger(target) || target < 1000) throw new Error("--rows is a whole number, 1,000 or more");
  const adminUrl = BENCH_DATABASE_ADMIN_URL();
  mustBeLocal(adminUrl);
  const started = Date.now();
  const { resetDatabase } = await import("@/db/reset-database");
  await resetDatabase({ adminUrl, appUrl: BENCH_DATABASE_URL() });
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  const [fw] = await sql`select id from workspaces where subdomain = 'fernwood'`;
  const grown = await grow(sql, fw!.id as string, target);
  const wide = await addWide(sql, fw!.id as string);
  await sql.end();
  console.log(`Admissions (6 sheets × 40 questions, 20 rules): ${wide.toLocaleString("en-US")} rows`);
  console.log(`bike_bench: Fernwood with ${grown.rows.toLocaleString("en-US")} rows (${grown.copies} copies), ${grown.people} people, ${grown.audit.toLocaleString("en-US")} Audit entries, ${grown.waits.toLocaleString("en-US")} waits, ${grown.ruleRuns.toLocaleString("en-US")} rule runs, in ${Math.round((Date.now() - started) / 1000)} s`);
  process.exit(0);
}
