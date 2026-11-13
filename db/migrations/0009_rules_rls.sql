-- Rules tables: the same row-level security as 0001_rls.sql.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['waits', 'rule_runs', 'outbox', 'ai_steps', 'morning_emails'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY workspace_rows ON %I USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id())', t);
  END LOOP;
END $$;
--> statement-breakpoint

DO $$ BEGIN REVOKE ALL ON waits, rule_runs, outbox, ai_steps, morning_emails FROM PUBLIC; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host refuses changes to PUBLIC; new tables give PUBLIC nothing)'; END $$;
--> statement-breakpoint
-- A wait is cleared, an email marked sent and an AI step's status moved on; nothing is deleted.
DO $$ BEGIN GRANT SELECT, INSERT, UPDATE ON waits, outbox, ai_steps TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
--> statement-breakpoint
-- The run logs are written once.
DO $$ BEGIN GRANT SELECT, INSERT ON rule_runs, morning_emails TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
--> statement-breakpoint

-- The daily job's one look across workspaces: each workspace's id and time zone, nothing else.
CREATE OR REPLACE FUNCTION all_workspaces()
  RETURNS TABLE (id uuid, time_zone text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT w.id, w.time_zone FROM workspaces w ORDER BY w.created_at
  $$;
--> statement-breakpoint
DO $$ BEGIN REVOKE ALL ON FUNCTION all_workspaces() FROM PUBLIC; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host refuses changes to PUBLIC; new tables give PUBLIC nothing)'; END $$;
--> statement-breakpoint
DO $$ BEGIN GRANT EXECUTE ON FUNCTION all_workspaces() TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
