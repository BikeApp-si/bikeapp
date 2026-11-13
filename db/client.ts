import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

const cache = globalThis as unknown as { bikeDb?: Db; bikeSql?: postgres.Sql; bikeQueries?: string[] };

// The kernel study's bench (BIKE_BENCH=1, scripts/bench.ts) counts the queries each path sends; never otherwise.
export const benchQueries = () => (cache.bikeQueries ??= []);

// The app's connection, as bike_app: row-level security always applies. DATABASE_POOLED=1 when DATABASE_URL
// goes through a transaction pooler (PgBouncer): no prepared statements then, and each request's settings are
// already per transaction (set_config(…, true)), which a pooler keeps.
export function db(): Db {
  if (!cache.bikeDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Set DATABASE_URL in .env");
    const debug = process.env.BIKE_BENCH === "1" ? (_c: number, query: string) => void benchQueries().push(query) : undefined;
    cache.bikeSql = postgres(url, { max: 10, onnotice: () => {}, prepare: process.env.DATABASE_POOLED !== "1", debug });
    cache.bikeDb = drizzle(cache.bikeSql, { schema });
  }
  return cache.bikeDb;
}

export async function closeDb() {
  await cache.bikeSql?.end();
  cache.bikeDb = undefined;
  cache.bikeSql = undefined;
}
