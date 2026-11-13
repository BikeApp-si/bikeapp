CREATE TABLE "ontologies" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"input_hash" text NOT NULL,
	"written" jsonb NOT NULL,
	"written_at" timestamp with time zone NOT NULL,
	"written_by" uuid
);
--> statement-breakpoint
ALTER TABLE "ontologies" ADD CONSTRAINT "ontologies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ontologies" ADD CONSTRAINT "ontologies_written_by_people_id_fk" FOREIGN KEY ("written_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE ontologies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ontologies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_rows ON ontologies USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
--> statement-breakpoint
DO $$ BEGIN REVOKE ALL ON ontologies FROM PUBLIC; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host refuses changes to PUBLIC; new tables give PUBLIC nothing)'; END $$;
--> statement-breakpoint
-- One current version: written, then written again in place.
DO $$ BEGIN GRANT SELECT, INSERT, UPDATE ON ontologies TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
