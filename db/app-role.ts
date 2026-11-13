// The app's own database user (bike_app: no superuser, no way past row-level security), made or brought up to
// date before the database updates run. The open Bike's web container runs it on start (docker/start.sh), so its
// database needs no setup by hand; the password is DATABASE_URL's. Usage: tsx db/app-role.ts
import postgres from "postgres";
import { direct } from "./urls";

try { process.loadEnvFile(); } catch {}

export async function ensureAppRole(adminUrl: string, appUrl: string): Promise<"made" | "kept"> {
  const app = new URL(appUrl);
  const role = decodeURIComponent(app.username);
  const password = decodeURIComponent(app.password);
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`DATABASE_URL's user "${role}" isn't a plain name`);
  if (!password) throw new Error("DATABASE_URL needs the app's password");
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    const [found] = await sql`select 1 from pg_roles where rolname = ${role}`;
    // The password goes in as a literal Postgres quotes itself: CREATE ROLE takes no parameters.
    const quoted = (await sql`select quote_literal(${password}) as q`)[0]!.q as string;
    if (found) {
      await sql.unsafe(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${quoted}`);
      return "kept";
    }
    await sql.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD ${quoted} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    return "made";
  } finally {
    await sql.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const admin = process.env.DATABASE_ADMIN_URL;
  const app = process.env.DATABASE_URL;
  if (!admin || !app) throw new Error("Set DATABASE_ADMIN_URL and DATABASE_URL in .env");
  const done = await ensureAppRole(direct(admin), app);
  console.log(done === "made" ? "Made the app's database user" : "The app's database user is ready");
}
