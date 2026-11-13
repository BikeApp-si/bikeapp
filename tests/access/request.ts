import postgres from "postgres";
import { SESSION_COOKIE } from "@/server/auth/session";

// A forged request, as the access tests send it: the host and the cookies are whatever the test says, and
// the action's arguments are whatever it passes. next/headers reads from here (each test file mocks it).
export const req = { host: "", cookies: new Map<string, string>() };

export const ROOT = process.env.ROOT_HOST ?? "localhost:3000";
export function onHost(sub: string | null, session?: string) {
  req.host = sub ? `${sub}.${ROOT}` : ROOT;
  req.cookies = new Map(session ? [[SESSION_COOKIE, session]] : []);
}

// Every table with a workspace_id, counted as the database owner (no RLS): what a refused call must leave
// as it was. Sign-in attempts (auth_codes, rate_limit_events) are counted only where a case says so.
const admin = () => postgres(process.env.TEST_DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let sql: ReturnType<typeof admin> | null = null;
export async function counts(): Promise<Record<string, number>> {
  sql ??= admin();
  const tables = await sql<{ table_name: string }[]>`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'workspace_id' and table_name not in ('rate_limit_events', 'auth_codes')
    order by table_name`;
  const out: Record<string, number> = {};
  for (const { table_name } of tables) out[table_name] = (await sql.unsafe(`select count(*)::int as n from "${table_name}"`))[0]!.n as number;
  return out;
}
export async function owner<T extends postgres.Row>(q: (s: ReturnType<typeof admin>) => Promise<T[]>) {
  sql ??= admin();
  return q(sql);
}
export async function closeOwner() {
  await sql?.end();
  sql = null;
}
