CREATE TABLE "coherence_checks" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"input_hash" text NOT NULL,
	"items" jsonb NOT NULL,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coherence_checks" ADD CONSTRAINT "coherence_checks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE coherence_checks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE coherence_checks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_rows ON coherence_checks USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
--> statement-breakpoint
DO $$ BEGIN REVOKE ALL ON coherence_checks FROM PUBLIC; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host refuses changes to PUBLIC; new tables give PUBLIC nothing)'; END $$;
--> statement-breakpoint
-- One current result: written, then written again in place.
DO $$ BEGIN GRANT SELECT, INSERT, UPDATE ON coherence_checks TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
