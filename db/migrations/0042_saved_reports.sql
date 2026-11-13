-- M33 · Saved and scheduled reports. A saved report is read only by its author; the daily job, acting as nobody
-- (no person set), reads every one in its workspace to find what is due. Sends are written once, as 0041's runs.
CREATE TABLE "saved_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"first_id" uuid NOT NULL,
	"saved_at" timestamp with time zone NOT NULL,
	"unsaved_at" timestamp with time zone,
	"every" jsonb,
	"every_since" date,
	"stopped_why" text
);
--> statement-breakpoint
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_author_id_people_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_first_id_reports_id_fk" FOREIGN KEY ("first_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saved_reports_first" ON "saved_reports" USING btree ("workspace_id","first_id");--> statement-breakpoint
CREATE INDEX "saved_reports_author" ON "saved_reports" USING btree ("workspace_id","author_id");--> statement-breakpoint
ALTER TABLE "saved_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "saved_reports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY author_or_job ON "saved_reports"
  USING (workspace_id = app_workspace_id() AND (app_person_id() IS NULL OR author_id = app_person_id()))
  WITH CHECK (workspace_id = app_workspace_id() AND (app_person_id() IS NULL OR author_id = app_person_id()));--> statement-breakpoint
DO $$ BEGIN REVOKE ALL ON saved_reports FROM PUBLIC; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host refuses changes to PUBLIC; new tables give PUBLIC nothing)'; END $$;
--> statement-breakpoint
DO $$ BEGIN GRANT SELECT, INSERT, UPDATE ON saved_reports TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
--> statement-breakpoint
CREATE TRIGGER bike_no_delete BEFORE DELETE ON saved_reports FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();--> statement-breakpoint
CREATE TRIGGER bike_no_truncate BEFORE TRUNCATE ON saved_reports FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();--> statement-breakpoint
CREATE TABLE "report_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"saved_id" uuid NOT NULL,
	"on_date" date NOT NULL,
	"report_id" uuid,
	"refused" text,
	"sent_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_sends" ADD CONSTRAINT "report_sends_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_sends" ADD CONSTRAINT "report_sends_saved_id_saved_reports_id_fk" FOREIGN KEY ("saved_id") REFERENCES "public"."saved_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_sends" ADD CONSTRAINT "report_sends_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_sends_once" ON "report_sends" USING btree ("saved_id","on_date");--> statement-breakpoint
ALTER TABLE "report_sends" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "report_sends" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY through_saved ON "report_sends"
  USING (workspace_id = app_workspace_id() AND saved_id IN (SELECT id FROM saved_reports))
  WITH CHECK (workspace_id = app_workspace_id() AND saved_id IN (SELECT id FROM saved_reports));--> statement-breakpoint
DO $$ BEGIN REVOKE ALL ON report_sends FROM PUBLIC; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host refuses changes to PUBLIC; new tables give PUBLIC nothing)'; END $$;
--> statement-breakpoint
DO $$ BEGIN GRANT SELECT, INSERT ON report_sends TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
--> statement-breakpoint
CREATE TRIGGER bike_no_update BEFORE UPDATE ON report_sends FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();--> statement-breakpoint
CREATE TRIGGER bike_no_delete BEFORE DELETE ON report_sends FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();--> statement-breakpoint
CREATE TRIGGER bike_no_truncate BEFORE TRUNCATE ON report_sends FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();
