-- Kernel tables: the same row-level security as 0001_rls.sql.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['capabilities', 'capability_versions', 'change_sets', 'rows'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY workspace_rows ON %I USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id())', t);
  END LOOP;
END $$;
--> statement-breakpoint

DO $$ BEGIN REVOKE ALL ON capabilities, capability_versions, change_sets, rows FROM PUBLIC; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host refuses changes to PUBLIC; new tables give PUBLIC nothing)'; END $$;
--> statement-breakpoint
-- Rows are soft-deleted, so the app never needs DELETE on them.
DO $$ BEGIN GRANT SELECT, INSERT, UPDATE ON capabilities, rows TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
--> statement-breakpoint
-- A file version and a change set are written once and never changed.
DO $$ BEGIN GRANT SELECT, INSERT ON capability_versions, change_sets TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
