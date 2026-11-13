CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"capability_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"column_id" text NOT NULL,
	"ai_step_id" uuid NOT NULL,
	"value" jsonb NOT NULL,
	"reason" text NOT NULL,
	"confidence" real NOT NULL,
	"person_id" uuid,
	"status" text DEFAULT 'waiting' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_row_id_rows_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."rows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_ai_step_id_ai_steps_id_fk" FOREIGN KEY ("ai_step_id") REFERENCES "public"."ai_steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_decided_by_people_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposals_row" ON "proposals" USING btree ("row_id");--> statement-breakpoint
CREATE INDEX "proposals_waiting" ON "proposals" USING btree ("workspace_id","person_id","status");--> statement-breakpoint
ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE proposals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_rows ON proposals USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
--> statement-breakpoint
DO $$ BEGIN REVOKE ALL ON proposals FROM PUBLIC; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host refuses changes to PUBLIC; new tables give PUBLIC nothing)'; END $$;
--> statement-breakpoint
-- The worker adds a proposal for an AI step's answer; a person settles it. What was suggested never changes.
DO $$ BEGIN GRANT SELECT, INSERT ON proposals TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
--> statement-breakpoint
DO $$ BEGIN GRANT UPDATE (status, decided_by, decided_at) ON proposals TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights; 0023_locks.sql refuses what these grants left out)'; END $$;
