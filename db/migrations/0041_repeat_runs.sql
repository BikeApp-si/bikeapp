-- M32 · Rows that repeat: a repeating rule adds its rows at most once per date of its schedule. Row-level security
-- and the grants as 0009_rules_rls.sql; written once, never changed or removed, as 0023_locks.sql keeps rule_runs.
CREATE TABLE "repeat_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"capability_id" uuid NOT NULL,
	"rule_source" text NOT NULL,
	"rule_id" text NOT NULL,
	"on_date" date NOT NULL,
	"ran_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repeat_runs" ADD CONSTRAINT "repeat_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repeat_runs" ADD CONSTRAINT "repeat_runs_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repeat_runs_once" ON "repeat_runs" USING btree ("workspace_id","rule_source","rule_id","on_date");--> statement-breakpoint
ALTER TABLE "repeat_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "repeat_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY workspace_rows ON "repeat_runs" USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());--> statement-breakpoint
DO $$ BEGIN REVOKE ALL ON repeat_runs FROM PUBLIC; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host refuses changes to PUBLIC; new tables give PUBLIC nothing)'; END $$;
--> statement-breakpoint
DO $$ BEGIN GRANT SELECT, INSERT ON repeat_runs TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
--> statement-breakpoint
CREATE TRIGGER bike_no_update BEFORE UPDATE ON repeat_runs FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();--> statement-breakpoint
CREATE TRIGGER bike_no_delete BEFORE DELETE ON repeat_runs FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();--> statement-breakpoint
CREATE TRIGGER bike_no_truncate BEFORE TRUNCATE ON repeat_runs FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();
