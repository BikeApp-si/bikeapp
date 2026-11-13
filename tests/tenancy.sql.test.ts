// Done when, by SQL: as the app's database role, one workspace can't read or change another's rows.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { seed } from "@/seed";
import { createSession, createHandoff } from "@/server/auth/session";
import { withWorkspace } from "@/server/kernel/tx";

const app = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
let fernwood: string;
let acme: string;
// Each workspace's admin, who writes its chat.
const authors = new Map<string, string>();
const probeChats = new Map<string, string>(); // the chat each workspace's test author writes

const TABLES = [
  "workspaces", "people", "sessions", "handoff_tokens", "audit_entries", "uploads", "auth_codes",
  "capabilities", "capability_versions", "change_sets", "rows",
  "waits", "rule_runs", "outbox", "ai_calls", "customize_suggestions", "jobs", "company_rules", "views", "table_prefs",
  "row_notes", "tutorials", "tutorial_seen",
] as const;

// Runs fn as bike_app with app.workspace_id (and app.person_id) set or not, inside a transaction that is
// rolled back.
async function as<T>(workspaceId: string | null, fn: (sql: postgres.TransactionSql) => Promise<T>, personId?: string): Promise<T> {
  let out: T;
  await app
    .begin(async (sql) => {
      if (workspaceId) await sql`select set_config('app.workspace_id', ${workspaceId}, true)`;
      if (personId) await sql`select set_config('app.person_id', ${personId}, true)`;
      out = await fn(sql);
      throw new Rollback();
    })
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
  return out!;
}
class Rollback extends Error {}

beforeAll(async () => {
  const s = await seed();
  fernwood = s.fernwood.workspaceId;
  acme = s.acme.workspaceId;
  // Give every table at least one row in each workspace.
  for (const ws of [fernwood, acme]) {
    await withWorkspace({ workspaceId: ws }, async (tx) => {
      const [p] = await tx.execute<{ id: string }>(`select id from people where is_admin limit 1`);
      await createSession(tx, { workspaceId: ws, personId: p!.id });
      await createHandoff(tx, { workspaceId: ws, personId: p!.id });
      await tx.execute(`insert into uploads (workspace_id, key, name, mime, size) values ('${ws}', 'workspaces/${ws}/a.pdf', 'a.pdf', 'application/pdf', 1)`);
      await tx.execute(`insert into auth_codes (workspace_id, email, code_hash, expires_at) values ('${ws}', 'x@x.dev', 'h', now())`);
      const [cap] = await tx.execute<{ id: string }>(
        // Deleted, so its empty file never reaches a kernel read in other tests; RLS still applies to it.
        `insert into capabilities (workspace_id, name, icon, current_version, deleted_at) values ('${ws}', 'Probe', 'layout-grid', 1, now()) returning id`,
      );
      await tx.execute(`insert into change_sets (workspace_id, source) values ('${ws}', 'build')`);
      await tx.execute(`insert into capability_versions (workspace_id, capability_id, version, file) values ('${ws}', '${cap!.id}', 1, '{}')`);
      await tx.execute(`insert into rows (workspace_id, capability_id, sheet_id, file_version) values ('${ws}', '${cap!.id}', 's', 1)`);
      await tx.execute(`insert into ai_calls (workspace_id, prompt, version, model, tokens_in, tokens_out, cost_usd, ms, passed) values ('${ws}', 'probe', 1, 'm', 1, 1, 0, 1, true)`);
      await tx.execute(`insert into customize_suggestions (workspace_id, capability_id, version, items) values ('${ws}', '${cap!.id}', 1, '[]')`);
      // An empty list, so the company's rules stay none for every other test.
      await tx.execute(`insert into company_rules (workspace_id, version, rules) values ('${ws}', 1, '[]')`);
      // A view and table preferences (0.4) on the probe capability, so no other test sees them.
      await tx.execute(`insert into views (workspace_id, capability_id, sheet_id, name, filters) values ('${ws}', '${cap!.id}', 's', 'Probe', '[]')`);
      await tx.execute(`insert into table_prefs (workspace_id, person_id, capability_id, sheet_id, columns) values ('${ws}', '${p!.id}', '${cap!.id}', 's', '{}')`);
      // A note (0.4, M22) on the probe capability's row.
      const [row] = await tx.execute<{ id: string }>(`select id from rows where workspace_id = '${ws}' and capability_id = '${cap!.id}' limit 1`);
      await tx.execute(`insert into row_notes (workspace_id, capability_id, row_id, author_id, text) values ('${ws}', '${cap!.id}', '${row!.id}', '${p!.id}', 'Probe')`);
      // A tutorial (0.4, M24) on the probe capability, and its "Got it".
      const [tut] = await tx.execute<{ id: string }>(`insert into tutorials (workspace_id, capability_id, version, access_hash, page, steps_hash) values ('${ws}', '${cap!.id}', 1, 'probe', '{}', 'probe') returning id`);
      await tx.execute(`insert into tutorial_seen (workspace_id, person_id, capability_id, tutorial_id, steps_hash) values ('${ws}', '${p!.id}', '${cap!.id}', '${tut!.id}', 'probe')`);
      // Done already, so no test's worker run picks it up.
      await tx.execute(`insert into jobs (workspace_id, kind, payload, status, created_at) values ('${ws}', 'probe', '{}', 'done', now())`);
    });
  }
  // One chat in each workspace, written by its admin, with a message and a plan.
  for (const ws of [fernwood, acme]) {
    const [admin] = await as(ws, (sql) => sql`select id from people where is_admin order by name limit 1`);
    authors.set(ws, admin!.id as string);
    await withWorkspace({ workspaceId: ws, personId: admin!.id as string }, async (tx) => {
      const [chat] = await tx.execute<{ id: string }>(`insert into chats (workspace_id, author_id, kind) values ('${ws}', '${admin!.id}', 'capability') returning id`);
      probeChats.set(ws, chat!.id);
      await tx.execute(`insert into messages (workspace_id, chat_id, "from", text) values ('${ws}', '${chat!.id}', 'person', 'Track contracts')`);
      await tx.execute(`insert into plans (workspace_id, chat_id, version, draft) values ('${ws}', '${chat!.id}', 1, '{}')`);
    });
  }
});
afterAll(() => app.end());

describe("row-level security as bike_app", () => {
  it("connects as a role that can't bypass RLS", async () => {
    const [r] = await app`select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    expect(r).toMatchObject({ current_user: "bike_app", rolsuper: false, rolbypassrls: false });
  });

  it.each(TABLES)("%s: Fernwood sees its own rows and none of Acme's", async (table) => {
    const col = table === "workspaces" ? "id" : "workspace_id";
    const rows = await as(fernwood, (sql) => sql`select ${sql(col)} as ws from ${sql(table)}`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.ws === fernwood)).toBe(true);
    const [row] = await as(fernwood, (sql) => sql`select count(*)::int as n from ${sql(table)} where ${sql(col)} = ${acme}`);
    expect(row?.n).toBe(0);
  });

  // Sign-up codes have no workspace and are meant to be visible on the root host; workspace codes are not.
  it.each(TABLES)("%s: with no workspace set, no workspace's rows are visible", async (table) => {
    const col = table === "workspaces" ? "id" : "workspace_id";
    const [row] = await as(null, (sql) => sql`select count(*)::int as n from ${sql(table)} where ${sql(col)} is not null`);
    expect(row?.n).toBe(0);
  });

  it("refuses to insert a row for another workspace", async () => {
    await expect(as(fernwood, (sql) => sql`insert into people (workspace_id, name, email) values (${acme}, 'Mole', 'mole@acme.test')`)).rejects.toThrow(
      /row-level security/,
    );
  });

  it("can't update or delete another workspace's rows, or move a row across", async () => {
    const updated = await as(fernwood, (sql) => sql`update people set name = 'Hacked' where workspace_id = ${acme}`);
    expect(updated.count).toBe(0);
    const deleted = await as(fernwood, (sql) => sql`delete from sessions where workspace_id = ${acme}`);
    expect(deleted.count).toBe(0);
    await expect(as(fernwood, (sql) => sql`update people set workspace_id = ${acme}`)).rejects.toThrow(/row-level security/);
  });

  it("can't change another workspace's setup or the fields it fills", async () => {
    const changed = await as(fernwood, (sql) => sql`update workspaces set setup = '{"step":"done","messages":[]}', setup_done_at = now(), currency = 'XXX' where id = ${acme}`);
    expect(changed.count).toBe(0);
  });

  it("keeps the Audit log append-only", async () => {
    await expect(as(fernwood, (sql) => sql`update audit_entries set event = 'x'`)).rejects.toThrow(/permission denied/);
    await expect(as(fernwood, (sql) => sql`delete from audit_entries`)).rejects.toThrow(/permission denied/);
  });

  it("keeps tutorials as written (0.4)", async () => {
    await expect(as(fernwood, (sql) => sql`update tutorials set page = '{}'`)).rejects.toThrow(/permission denied/);
  });

  it("keeps notes as posted (0.4)", async () => {
    await expect(as(fernwood, (sql) => sql`update row_notes set text = 'x'`)).rejects.toThrow(/permission denied/);
    await expect(as(fernwood, (sql) => sql`delete from row_notes`)).rejects.toThrow(/permission denied/);
  });

  it("keeps file versions and change sets as written, and rows are never hard-deleted", async () => {
    await expect(as(fernwood, (sql) => sql`update capability_versions set file = '{}'`)).rejects.toThrow(/permission denied/);
    await expect(as(fernwood, (sql) => sql`delete from capability_versions`)).rejects.toThrow(/permission denied/);
    await expect(as(fernwood, (sql) => sql`update change_sets set source = 'x'`)).rejects.toThrow(/permission denied/);
    await expect(as(fernwood, (sql) => sql`delete from rows`)).rejects.toThrow(/permission denied/);
    await expect(as(fernwood, (sql) => sql`update customize_suggestions set items = '[]'`)).rejects.toThrow(/permission denied/);
    await expect(as(fernwood, (sql) => sql`update company_rules set rules = '[]'`)).rejects.toThrow(/permission denied/);
    await expect(as(fernwood, (sql) => sql`delete from company_rules`)).rejects.toThrow(/permission denied/);
  });

  it("lets the app add jobs and mark them, but not change what a job does or remove one", async () => {
    await expect(as(fernwood, (sql) => sql`update jobs set payload = '{}'`)).rejects.toThrow(/permission denied/);
    await expect(as(fernwood, (sql) => sql`update jobs set kind = 'x'`)).rejects.toThrow(/permission denied/);
    await expect(as(fernwood, (sql) => sql`delete from jobs`)).rejects.toThrow(/permission denied/);
    const marked = await as(fernwood, (sql) => sql`update jobs set status = 'done'`);
    expect(marked.count).toBeGreaterThan(0);
    await expect(as(fernwood, (sql) => sql`insert into jobs (workspace_id, kind, payload, created_at) values (${acme}, 'design', '{}', now())`)).rejects.toThrow(/row-level security/);
  });

  it("can't switch RLS off", async () => {
    await expect(as(fernwood, (sql) => sql`alter table people disable row level security`)).rejects.toThrow(/must be owner/);
    await expect(as(fernwood, (sql) => sql`set local row_security = off; select * from people`.simple())).rejects.toThrow(/row-level security/);
    await expect(as(fernwood, (sql) => sql`set local role bike`.simple())).rejects.toThrow(/permission denied/);
  });

  it("the address lookup returns the lookup fields only", async () => {
    const rows = await as(null, (sql) => sql`select * from workspace_by_subdomain('acme')`);
    expect(Object.keys(rows[0]!).sort()).toEqual(["id", "name", "short_name", "time_zone"]);
  });
});

describe("chats are private to their author", () => {
  const CHAT_TABLES = ["chats", "messages", "plans"] as const;

  it.each(CHAT_TABLES)("%s: the author sees their own; another admin, no one and the other workspace see nothing", async (table) => {
    const author = authors.get(fernwood)!;
    // Rows of the author's chat (Fernwood's other admin, Wade, also has the seed's report chats).
    const chat = probeChats.get(fernwood)!;
    const count = (ws: string | null, person?: string) =>
      as(ws, (sql) => sql`select count(*)::int as n from ${sql(table)} where ${sql(table === "chats" ? "id" : "chat_id")} = ${chat}`, person).then((r) => r[0]!.n as number);
    expect(await count(fernwood, author)).toBe(1);
    const [other] = await as(fernwood, (sql) => sql`select id from people where id <> ${author} and is_admin limit 1`);
    expect(await count(fernwood, other!.id as string)).toBe(0);
    expect(await count(fernwood)).toBe(0);
    expect(await count(null)).toBe(0);
    // The Acme admin, even with Fernwood's workspace set, sees no Fernwood chat.
    expect(await count(fernwood, authors.get(acme)!)).toBe(0);
  });

  it("refuses a chat written for someone else, and a message on someone else's chat", async () => {
    const author = authors.get(fernwood)!;
    const [other] = await as(fernwood, (sql) => sql`select id from people where id <> ${author} limit 1`);
    await expect(
      as(fernwood, (sql) => sql`insert into chats (workspace_id, author_id, kind) values (${fernwood}, ${author}, 'capability')`, other!.id as string),
    ).rejects.toThrow(/row-level security/);
    const [chat] = await as(fernwood, (sql) => sql`select id from chats`, author);
    await expect(
      as(fernwood, (sql) => sql`insert into messages (workspace_id, chat_id, "from") values (${fernwood}, ${chat!.id}, 'person')`, other!.id as string),
    ).rejects.toThrow(/row-level security/);
  });

  it("keeps chats and the AI log from being deleted, and the AI log as written", async () => {
    const author = authors.get(fernwood)!;
    for (const t of ["chats", "messages", "plans", "ai_calls"]) await expect(as(fernwood, (sql) => sql`delete from ${sql(t)}`, author)).rejects.toThrow(/permission denied/);
    await expect(as(fernwood, (sql) => sql`update ai_calls set passed = false`)).rejects.toThrow(/permission denied/);
  });
});
