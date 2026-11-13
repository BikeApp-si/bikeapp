-- O2 · Settings › Instance: how many updates to the database are applied, so the health check can say whether
-- any are missing. The app's role can't read the migrations table itself; this tells it the count, nothing else.
CREATE OR REPLACE FUNCTION migrations_applied()
  RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT count(*)::int FROM drizzle.__drizzle_migrations
  $$;
--> statement-breakpoint
DO $$ BEGIN REVOKE ALL ON FUNCTION migrations_applied() FROM PUBLIC; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host refuses changes to PUBLIC; new tables give PUBLIC nothing)'; END $$;
--> statement-breakpoint
DO $$ BEGIN GRANT EXECUTE ON FUNCTION migrations_applied() TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
