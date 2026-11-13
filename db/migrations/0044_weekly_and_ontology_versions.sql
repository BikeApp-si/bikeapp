-- M34 · What changed this week, and the Ontology's versions. Both written once, never changed or removed.
CREATE TABLE "ontology_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"input_hash" text NOT NULL,
	"written" jsonb NOT NULL,
	"read" jsonb NOT NULL,
	"written_at" timestamp with time zone NOT NULL,
	"written_by" uuid
);
--> statement-breakpoint
ALTER TABLE "ontology_versions" ADD CONSTRAINT "ontology_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ontology_versions" ADD CONSTRAINT "ontology_versions_written_by_people_id_fk" FOREIGN KEY ("written_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ontology_versions_once" ON "ontology_versions" USING btree ("workspace_id","version");--> statement-breakpoint
-- The version current today is the first one kept (earlier ones were written over). What it read: each app's
-- version saved at or before it was written, by the app's name then.
INSERT INTO "ontology_versions" ("workspace_id", "version", "input_hash", "written", "read", "written_at", "written_by")
SELECT o.workspace_id, o.version, o.input_hash, o.written,
  coalesce((SELECT jsonb_agg(jsonb_build_object('id', v.capability_id, 'name', v.file->>'name', 'version', v.version) ORDER BY c.position)
    FROM capabilities c
    JOIN LATERAL (SELECT * FROM capability_versions cv WHERE cv.capability_id = c.id AND cv.created_at <= o.written_at ORDER BY cv.version DESC LIMIT 1) v ON true
    WHERE c.workspace_id = o.workspace_id AND (c.deleted_at IS NULL OR c.deleted_at > o.written_at)), '[]'::jsonb),
  o.written_at, o.written_by
FROM ontologies o;--> statement-breakpoint
ALTER TABLE "ontology_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ontology_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY workspace_rows ON "ontology_versions" USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());--> statement-breakpoint
DO $$ BEGIN REVOKE ALL ON ontology_versions FROM PUBLIC; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host refuses changes to PUBLIC; new tables give PUBLIC nothing)'; END $$;
--> statement-breakpoint
DO $$ BEGIN GRANT SELECT, INSERT ON ontology_versions TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
--> statement-breakpoint
CREATE TRIGGER bike_no_update BEFORE UPDATE ON ontology_versions FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();--> statement-breakpoint
CREATE TRIGGER bike_no_delete BEFORE DELETE ON ontology_versions FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();--> statement-breakpoint
CREATE TRIGGER bike_no_truncate BEFORE TRUNCATE ON ontology_versions FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();--> statement-breakpoint
CREATE TABLE "weekly_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"week_of" date NOT NULL,
	"quiet" boolean NOT NULL,
	"sent_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "weekly_emails" ADD CONSTRAINT "weekly_emails_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_emails" ADD CONSTRAINT "weekly_emails_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_emails_once" ON "weekly_emails" USING btree ("person_id","week_of");--> statement-breakpoint
ALTER TABLE "weekly_emails" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "weekly_emails" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY workspace_rows ON "weekly_emails" USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());--> statement-breakpoint
DO $$ BEGIN REVOKE ALL ON weekly_emails FROM PUBLIC; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host refuses changes to PUBLIC; new tables give PUBLIC nothing)'; END $$;
--> statement-breakpoint
DO $$ BEGIN GRANT SELECT, INSERT ON weekly_emails TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
--> statement-breakpoint
CREATE TRIGGER bike_no_update BEFORE UPDATE ON weekly_emails FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();--> statement-breakpoint
CREATE TRIGGER bike_no_delete BEFORE DELETE ON weekly_emails FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();--> statement-breakpoint
CREATE TRIGGER bike_no_truncate BEFORE TRUNCATE ON weekly_emails FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();
