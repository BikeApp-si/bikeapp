CREATE TABLE "customize_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"capability_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"items" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customize_suggestions" ADD CONSTRAINT "customize_suggestions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customize_suggestions" ADD CONSTRAINT "customize_suggestions_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customize_suggestions_cap_version" ON "customize_suggestions" USING btree ("capability_id","version");--> statement-breakpoint
ALTER TABLE customize_suggestions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE customize_suggestions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_rows ON customize_suggestions USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
--> statement-breakpoint
DO $$ BEGIN REVOKE ALL ON customize_suggestions FROM PUBLIC; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host refuses changes to PUBLIC; new tables give PUBLIC nothing)'; END $$;
--> statement-breakpoint
DO $$ BEGIN GRANT SELECT, INSERT ON customize_suggestions TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
