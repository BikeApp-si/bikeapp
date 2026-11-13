-- O2 · The open Bike's first run. One row, before any company exists: the setup code written to Bike's log (its
-- hash), the tries left, and when first run was done. Like sign ups, it belongs to no workspace: only a
-- transaction with no workspace set (withRoot) sees it, and it is never removed.
CREATE TABLE "instance_setup" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL CHECK ("id" = 1),
	"code_hash" text NOT NULL,
	"tries_left" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "instance_setup" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "instance_setup" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY root_only ON "instance_setup" USING (app_workspace_id() IS NULL) WITH CHECK (app_workspace_id() IS NULL);--> statement-breakpoint
DO $$ BEGIN REVOKE ALL ON instance_setup FROM PUBLIC; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host refuses changes to PUBLIC; new tables give PUBLIC nothing)'; END $$;
--> statement-breakpoint
DO $$ BEGIN GRANT SELECT, INSERT, UPDATE ON instance_setup TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
--> statement-breakpoint
CREATE TRIGGER bike_no_delete BEFORE DELETE ON instance_setup FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();--> statement-breakpoint
CREATE TRIGGER bike_no_truncate BEFORE TRUNCATE ON instance_setup FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();
