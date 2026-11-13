-- A row's own history and notes (0.4, M22). Audit entries about rows name them (row_ids), so a row's History reads
-- them back; the log stays append-only. A note is a person's short text on a row, fixed once posted: the app may add
-- and read notes, never change or remove them.
ALTER TABLE "audit_entries" ADD COLUMN "row_ids" uuid[];--> statement-breakpoint
CREATE INDEX "audit_entries_rows" ON "audit_entries" USING gin ("row_ids");--> statement-breakpoint
CREATE TABLE "row_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"capability_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "row_notes" ADD CONSTRAINT "row_notes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_notes" ADD CONSTRAINT "row_notes_author_id_people_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "row_notes_row" ON "row_notes" USING btree ("workspace_id","row_id");--> statement-breakpoint
ALTER TABLE row_notes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE row_notes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_rows ON row_notes USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
--> statement-breakpoint
DO $$ BEGIN REVOKE ALL ON row_notes FROM PUBLIC; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host refuses changes to PUBLIC; new tables give PUBLIC nothing)'; END $$;
--> statement-breakpoint
DO $$ BEGIN GRANT SELECT, INSERT ON row_notes TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights)'; END $$;
