// The direct connection for what a transaction pooler can't carry (LISTEN, migrations, pg-boss): the same
// URL with its host swapped for DATABASE_DIRECT_HOST (Fly Managed Postgres: direct.<cluster>.flympg.net),
// so the passwords stay in the one secret Fly set. Without DATABASE_DIRECT_HOST, the URL as it is.
export function direct(url: string, env: Record<string, string | undefined> = process.env): string {
  const host = env.DATABASE_DIRECT_HOST;
  if (!host) return url;
  const u = new URL(url);
  u.hostname = host;
  return u.toString();
}
