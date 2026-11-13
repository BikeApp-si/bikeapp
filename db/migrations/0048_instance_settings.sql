-- O3 · The open Bike's own settings, beside any company: the company's Anthropic key (sealed with SESSION_SECRET,
-- server/crypto/secret.ts, with its last four characters to show) and the monthly AI cap in dollars. One row, only
-- visible with no workspace set (withRoot), like instance_setup; never removed.
CREATE TABLE "instance_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL CHECK ("id" = 1),
	"ai_key_sealed" text,
	"ai_key_last4" text,
	"ai_cap_usd" numeric(10, 2),
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "instance_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY root_only ON "instance_settings" USING (app_workspace_id() IS NULL) WITH CHECK (app_workspace_id() IS NULL);--> statement-breakpoint
DO $$ BEGIN REVOKE ALL ON instance_settings FROM PUBLIC; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host refuses changes to PUBLIC; new tables give PUBLIC nothing)'; END $$;
--> statement-breakpoint
DO $$ BEGIN GRANT SELECT, INSERT, UPDATE ON instance_settings TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
--> statement-breakpoint
CREATE TRIGGER bike_no_delete BEFORE DELETE ON instance_settings FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();--> statement-breakpoint
CREATE TRIGGER bike_no_truncate BEFORE TRUNCATE ON instance_settings FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();
