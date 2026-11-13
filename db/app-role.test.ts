import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { ensureAppRole } from "./app-role";

// The open Bike's web container makes the app's database user itself: once, then only its password is kept current.
const admin = process.env.TEST_DATABASE_ADMIN_URL!;
const role = `bike_app_t${Date.now().toString(36)}`;
const appUrl = (password: string) => {
  const u = new URL(admin);
  u.username = role;
  u.password = password;
  return u.toString();
};

afterAll(async () => {
  const sql = postgres(admin, { max: 1, onnotice: () => {} });
  await sql.unsafe(`DROP ROLE IF EXISTS ${role}`);
  await sql.end();
});

describe("the app's database user", () => {
  it("is made without superuser or a way past row-level security, then kept with a new password", async () => {
    expect(await ensureAppRole(admin, appUrl("first it's'quoted"))).toBe("made");
    const sql = postgres(admin, { max: 1, onnotice: () => {} });
    const [r] = await sql`select rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin from pg_roles where rolname = ${role}`;
    await sql.end();
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolcanlogin: true });
    expect(await ensureAppRole(admin, appUrl("second"))).toBe("kept");
    const asApp = postgres(appUrl("second"), { max: 1, onnotice: () => {} });
    expect((await asApp`select current_user as u`)[0]!.u).toBe(role);
    await asApp.end();
  });

  it("refuses a user that isn't a plain name, or no password", async () => {
    const odd = new URL(admin);
    odd.username = "bike;drop";
    odd.password = "x";
    await expect(ensureAppRole(admin, odd.toString())).rejects.toThrow("isn't a plain name");
    const none = new URL(admin);
    none.username = "bike_app";
    none.password = "";
    await expect(ensureAppRole(admin, none.toString())).rejects.toThrow("needs the app's password");
  });
});
