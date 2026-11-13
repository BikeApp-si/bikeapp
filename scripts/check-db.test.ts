import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { checkDb } from "./check-db";

// The check Bike runs against production's app user after migrations. bike_app passes it, the owner (who can
// do anything) is caught by it, and a user built like Fly Managed Postgres's app user passes it too: a member
// of bike_app (so the same RLS policies apply) that can also write any table (pg_write_all_data), as Fly's
// "writer" role can. For that one only the triggers of 0023_locks.sql stand between it and the logs.

const asUser = (name: string) => {
  const u = new URL(process.env.TEST_DATABASE_ADMIN_URL!);
  u.username = name;
  u.password = name;
  return u.toString();
};

describe("the database check", () => {
  it("passes bike_app, and names everything wrong with the owner", async () => {
    expect(await checkDb(process.env.TEST_DATABASE_URL!)).toEqual([]);
    const owner = await checkDb(process.env.TEST_DATABASE_ADMIN_URL!);
    expect(owner.join(" ")).toMatch(/owns tables/);
  });

  it("passes a user with Fly's broad write rights: the triggers hold the rules", async () => {
    const sql = postgres(process.env.TEST_DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
    await sql.unsafe(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bike_app_flylike') THEN
        CREATE ROLE bike_app_flylike LOGIN PASSWORD 'bike_app_flylike' NOSUPERUSER NOBYPASSRLS IN ROLE bike_app, pg_read_all_data, pg_write_all_data;
      END IF; END $$`);
    await sql.end();
    expect(await checkDb(asUser("bike_app_flylike"))).toEqual([]);
  });

  it("lets the lookup functions' owner read workspaces, so an address is found on a managed host too", async () => {
    const sql = postgres(process.env.TEST_DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
    const rows = await sql`
      select p.cmd, p.roles::text[] as roles from pg_policies p
      where p.tablename = 'workspaces' and p.policyname = 'owner_lookups'`;
    const [owner] = await sql`select pg_get_userbyid(proowner) as name from pg_proc where proname = 'workspace_by_subdomain'`;
    await sql.end();
    expect(rows).toEqual([{ cmd: "SELECT", roles: [owner!.name] }]);
    // And the cost report's tables, read-only, for the same owner.
    const sql2 = postgres(process.env.TEST_DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
    const cost = await sql2`select tablename, cmd, roles::text[] as roles from pg_policies where policyname = 'owner_cost_report' order by tablename`;
    await sql2.end();
    expect(cost).toEqual(["ai_calls", "capabilities", "chats", "plans"].map((t) => ({ tablename: t, cmd: "SELECT", roles: [owner!.name] })));
  });
});
