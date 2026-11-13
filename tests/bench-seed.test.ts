import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { grow, mustBeLocal } from "@/scripts/bench-seed";

// The kernel study's company (M11, scripts/bench-seed.ts), grown small here: as many rows as asked, a staff of
// 200 in a manager chain, each copy's lines under its own documents, and stored totals that still add up.

const { seedFernwoodCopy } = await import("@/seed");
const sql = postgres(process.env.TEST_DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let ws: string;
let grown: Awaited<ReturnType<typeof grow>>;

beforeAll(async () => {
  ws = (await seedFernwoodCopy(`bench${Date.now().toString(36)}`)).workspaceId;
  grown = await grow(sql, ws, 2000);
}, 120_000);
afterAll(() => sql.end());

describe("the bench company", () => {
  it("has the rows and people asked for, in a manager chain", async () => {
    expect(grown.copies).toBeGreaterThan(0);
    expect(grown.rows).toBeGreaterThanOrEqual(2000);
    expect(grown.people).toBe(200);
    const [{ orphans }] = (await sql`select count(*)::int as orphans from people p where p.workspace_id = ${ws} and p.manager_id is not null and not exists (select 1 from people m where m.id = p.manager_id and m.workspace_id = ${ws})`) as unknown as [{ orphans: number }];
    expect(orphans).toBe(0);
  });

  it("keeps each copy's lines under a document of the same company, and its totals adding up", async () => {
    const [{ bad }] = (await sql`
      select count(*)::int as bad from rows l left join rows d on d.id = l.parent_row_id
      where l.workspace_id = ${ws} and l.parent_row_id is not null and (d.id is null or d.workspace_id <> ${ws} or d.deleted_at is not null)`) as unknown as [{ bad: number }];
    expect(bad).toBe(0);
    const off = await sql`
      select d.id from rows d join capabilities c on c.id = d.capability_id
      where d.workspace_id = ${ws} and c.name = 'Spend' and d.sheet_id = 'purchases' and d.deleted_at is null
        and coalesce((d.data->>'total')::bigint, 0) <> coalesce((select sum((l.data->>'amount')::bigint) from rows l where l.parent_row_id = d.id and l.deleted_at is null), 0)`;
    expect(off).toHaveLength(0);
  });

  it("only ever runs against a database on this machine", () => {
    expect(() => mustBeLocal("postgres://u:p@db.example.com:5432/bike")).toThrow("only runs against a database on localhost");
    expect(() => mustBeLocal("postgres://u:p@localhost:5432/bike_bench")).not.toThrow();
  });
});
