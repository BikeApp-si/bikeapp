// Checks the app's database user is locked down as Bike needs (the second lock behind the kernel): not a
// superuser, no bypassing row-level security, owns no table, every workspace table under RLS, nothing visible
// without a workspace set, and the Audit log, AI log and chats can't be rewritten or deleted.
// Usage: pnpm db:check                (DATABASE_URL, the app's user: run it against production after migrations)
//        pnpm db:check --test         (the test database)
// Prints each problem; exits 1 if there is any. Every write it tries is rolled back.
import postgres from "postgres";

class Rollback extends Error {}

export async function checkDb(appUrl: string): Promise<string[]> {
  const sql = postgres(appUrl, { max: 1, onnotice: () => {}, prepare: false });
  const problems: string[] = [];
  try {
    const [me] = await sql<{ user: string; super: boolean; bypass: boolean }[]>`
      select current_user as user, rolsuper as super, rolbypassrls as bypass from pg_roles where rolname = current_user`;
    if (me!.super) problems.push(`${me!.user} is a superuser.`);
    if (me!.bypass) problems.push(`${me!.user} can bypass row-level security.`);

    const owned = await sql<{ t: string }[]>`select tablename as t from pg_tables where schemaname = 'public' and tableowner = current_user`;
    if (owned.length) problems.push(`${me!.user} owns tables, so their rules don't hold it: ${owned.map((o) => o.t).join(", ")}.`);

    const open = await sql<{ t: string }[]>`
      select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
        and exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'workspace_id')`;
    if (open.length) problems.push(`Tables with workspaces but no row-level security: ${open.map((o) => o.t).join(", ")}.`);

    // With no workspace set, nothing of any workspace shows.
    for (const t of ["people", "rows", "audit_entries", "chats", "capabilities"]) {
      const [r] = await sql.unsafe(`select count(*)::int as n from "${t}"`);
      if (r!.n > 0) problems.push(`${t}: ${r!.n} rows visible with no workspace set.`);
    }

    // The logs and chats stay as written, even within one's own workspace (rolled back either way).
    for (const [what, q] of [
      ["delete from the Audit log", "delete from audit_entries"],
      ["rewrite the Audit log", "update audit_entries set event = event"],
      ["rewrite the AI log", "update ai_calls set passed = passed"],
      ["delete chats", "delete from chats"],
      ["delete rows outright", "delete from rows"],
      ["rewrite a capability's earlier versions", "update capability_versions set file = file"],
      ["rewrite the company's earlier rules", "update company_rules set rules = rules"],
      ["change what a job does", "update jobs set payload = payload"],
      ["change an AI suggestion's value", "update proposals set value = value"],
      ["empty the Audit log", "truncate audit_entries"],
      ["switch row-level security off", "alter table people disable row level security"],
    ] as const) {
      const allowed = await sql
        .begin(async (tx) => {
          await tx.unsafe(q);
          throw new Rollback();
        })
        .then(
          () => true,
          (e: Error) => e instanceof Rollback,
        );
      if (allowed) problems.push(`${me!.user} can ${what}.`);
    }
  } finally {
    await sql.end();
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.loadEnvFile(); } catch {}
  const url = process.argv.includes("--test") ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL (or TEST_DATABASE_URL with --test)");
  const problems = await checkDb(url);
  for (const p of problems) console.log(`✗ ${p}`);
  console.log(problems.length ? `${problems.length} problem(s)` : "✓ The app's database user is locked down: no superuser, no RLS bypass, no tables of its own, every workspace table under RLS, nothing visible without a workspace, logs and chats append-only.");
  process.exit(problems.length ? 1 : 0);
}
