-- Chats are private to their author: the workspace lock, plus the person the transaction runs as.
CREATE OR REPLACE FUNCTION app_person_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.person_id', true), '')::uuid $$;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['chats', 'messages', 'plans', 'ai_calls'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE POLICY author_only ON chats
  USING (workspace_id = app_workspace_id() AND author_id = app_person_id())
  WITH CHECK (workspace_id = app_workspace_id() AND author_id = app_person_id());
--> statement-breakpoint
-- Messages and plans are seen through their chat, so only by its author.
CREATE POLICY through_chat ON messages
  USING (workspace_id = app_workspace_id() AND chat_id IN (SELECT id FROM chats))
  WITH CHECK (workspace_id = app_workspace_id() AND chat_id IN (SELECT id FROM chats));
--> statement-breakpoint
CREATE POLICY through_chat ON plans
  USING (workspace_id = app_workspace_id() AND chat_id IN (SELECT id FROM chats))
  WITH CHECK (workspace_id = app_workspace_id() AND chat_id IN (SELECT id FROM chats));
--> statement-breakpoint
CREATE POLICY workspace_rows ON ai_calls USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
--> statement-breakpoint

DO $$ BEGIN REVOKE ALL ON chats, messages, plans, ai_calls FROM PUBLIC; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host refuses changes to PUBLIC; new tables give PUBLIC nothing)'; END $$;
--> statement-breakpoint
-- A chat's title and time move on; a Bike message is written as it is worked on; a plan is replaced or
-- created. Nothing is deleted.
DO $$ BEGIN GRANT SELECT, INSERT, UPDATE ON chats, messages, plans TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
--> statement-breakpoint
-- The AI log is written once.
DO $$ BEGIN GRANT SELECT, INSERT ON ai_calls TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
