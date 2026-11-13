CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"first_id" uuid,
	"title" text NOT NULL,
	"query" jsonb NOT NULL,
	"chart" text NOT NULL,
	"how" jsonb NOT NULL,
	"missing" text,
	"sentence" text NOT NULL,
	"result" jsonb NOT NULL,
	"ran_at" timestamp with time zone NOT NULL,
	"ran_as" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_ran_as_people_id_fk" FOREIGN KEY ("ran_as") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reports_chat" ON "reports" USING btree ("chat_id","ran_at");--> statement-breakpoint
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE reports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Seen through its chat, so only by its author.
CREATE POLICY through_chat ON reports
  USING (workspace_id = app_workspace_id() AND chat_id IN (SELECT id FROM chats))
  WITH CHECK (workspace_id = app_workspace_id() AND chat_id IN (SELECT id FROM chats));
--> statement-breakpoint
DO $$ BEGIN REVOKE ALL ON reports FROM PUBLIC; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host refuses changes to PUBLIC; new tables give PUBLIC nothing)'; END $$;
--> statement-breakpoint
-- A run is written once; Run again adds another.
DO $$ BEGIN GRANT SELECT, INSERT ON reports TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
