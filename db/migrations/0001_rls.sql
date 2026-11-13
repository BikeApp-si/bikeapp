-- Tenancy, second lock: row-level security on every table, forced for the owner too.
-- The app connects as bike_app (no BYPASSRLS). Every kernel transaction sets app.workspace_id.

CREATE OR REPLACE FUNCTION app_workspace_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;
--> statement-breakpoint

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_own ON workspaces USING (id = app_workspace_id()) WITH CHECK (id = app_workspace_id());
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['people', 'sessions', 'handoff_tokens', 'audit_entries', 'uploads'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY workspace_rows ON %I USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id())', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- Codes: sign-in codes belong to a workspace; sign-up codes (root host) have none.
ALTER TABLE auth_codes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE auth_codes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_rows ON auth_codes
  USING (workspace_id IS NOT DISTINCT FROM app_workspace_id())
  WITH CHECK (workspace_id IS NOT DISTINCT FROM app_workspace_id());
--> statement-breakpoint

-- Sign ups exist before any workspace: visible only when no workspace is set (the root host).
ALTER TABLE signups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE signups FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY root_only ON signups USING (app_workspace_id() IS NULL) WITH CHECK (app_workspace_id() IS NULL);
--> statement-breakpoint

-- Rate limits hold only hashed keys and times, no workspace data.
ALTER TABLE rate_limit_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE rate_limit_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY any_host ON rate_limit_events USING (true) WITH CHECK (true);
--> statement-breakpoint

-- The only two ways to look across workspaces. They return the address lookup, nothing else.
CREATE OR REPLACE FUNCTION workspace_by_subdomain(sub text)
  RETURNS TABLE (id uuid, name text, short_name text, time_zone text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT w.id, w.name, w.short_name, w.time_zone FROM workspaces w WHERE w.subdomain = lower(sub)
  $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subdomain_taken(sub text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (SELECT 1 FROM workspaces w WHERE w.subdomain = lower(sub))
  $$;
--> statement-breakpoint

DO $$ BEGIN REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host refuses changes to PUBLIC; new tables give PUBLIC nothing)'; END $$;
--> statement-breakpoint
DO $$ BEGIN REVOKE ALL ON FUNCTION workspace_by_subdomain(text), subdomain_taken(text) FROM PUBLIC; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host refuses changes to PUBLIC; new tables give PUBLIC nothing)'; END $$;
--> statement-breakpoint
DO $$ BEGIN GRANT USAGE ON SCHEMA public TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
--> statement-breakpoint
DO $$ BEGIN GRANT SELECT, INSERT, UPDATE, DELETE ON workspaces, people, signups, auth_codes, rate_limit_events, sessions, handoff_tokens, uploads TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
--> statement-breakpoint
-- The Audit log is append-only.
DO $$ BEGIN GRANT SELECT, INSERT ON audit_entries TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
--> statement-breakpoint
DO $$ BEGIN GRANT EXECUTE ON FUNCTION app_workspace_id(), workspace_by_subdomain(text), subdomain_taken(text) TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
