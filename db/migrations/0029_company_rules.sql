-- Company rules (0.2, M13): the company's rules as one versioned list, never changed; the newest is current.
CREATE TABLE "company_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"rules" jsonb NOT NULL,
	"change_set_id" uuid,
	"chat_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_rules" ADD CONSTRAINT "company_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_rules" ADD CONSTRAINT "company_rules_change_set_id_change_sets_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."change_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_rules" ADD CONSTRAINT "company_rules_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_rules_workspace_version" ON "company_rules" USING btree ("workspace_id","version");--> statement-breakpoint
CREATE INDEX "company_rules_workspace" ON "company_rules" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE company_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE company_rules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_rows ON company_rules USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
--> statement-breakpoint
DO $$ BEGIN REVOKE ALL ON company_rules FROM PUBLIC; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host refuses changes to PUBLIC; new tables give PUBLIC nothing)'; END $$;
--> statement-breakpoint
DO $$ BEGIN GRANT SELECT, INSERT ON company_rules TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; the triggers below refuse what these grants left out)'; END $$;
--> statement-breakpoint
-- Written once, never changed or removed (as 0023_locks.sql does for capability_versions).
CREATE TRIGGER bike_no_update BEFORE UPDATE ON company_rules FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();
--> statement-breakpoint
CREATE TRIGGER bike_no_delete BEFORE DELETE ON company_rules FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();
--> statement-breakpoint
CREATE TRIGGER bike_no_truncate BEFORE TRUNCATE ON company_rules FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();
