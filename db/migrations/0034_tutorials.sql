-- A tutorial for each capability (0.4, M24). One per capability, version and kind of access (the access summary's
-- hash), written once and read by everyone with that access. tutorial_seen keeps the tutorial each person last closed
-- ("Got it"), so the card comes back only when their own steps change. capabilities.introduce: the card shows on
-- capabilities created from now on, and on today's ones from their first Customize change; change_title names that
-- change on the card.
ALTER TABLE "capabilities" ADD COLUMN "introduce" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "capabilities" ALTER COLUMN "introduce" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "capabilities" ADD COLUMN "change_title" text;--> statement-breakpoint
CREATE TABLE "tutorials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"capability_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"access_hash" text NOT NULL,
	"page" jsonb NOT NULL,
	"steps_hash" text NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tutorial_seen" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"capability_id" uuid NOT NULL,
	"tutorial_id" uuid NOT NULL,
	"steps_hash" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tutorials" ADD CONSTRAINT "tutorials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutorial_seen" ADD CONSTRAINT "tutorial_seen_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutorial_seen" ADD CONSTRAINT "tutorial_seen_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tutorials_key" ON "tutorials" USING btree ("workspace_id","capability_id","version","access_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "tutorial_seen_person" ON "tutorial_seen" USING btree ("workspace_id","person_id","capability_id");--> statement-breakpoint
ALTER TABLE tutorials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tutorials FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_rows ON tutorials USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
--> statement-breakpoint
ALTER TABLE tutorial_seen ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tutorial_seen FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_rows ON tutorial_seen USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
--> statement-breakpoint
DO $$ BEGIN REVOKE ALL ON tutorials, tutorial_seen FROM PUBLIC; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host refuses changes to PUBLIC; new tables give PUBLIC nothing)'; END $$;
--> statement-breakpoint
DO $$ BEGIN GRANT SELECT, INSERT ON tutorials TO bike_app; GRANT SELECT, INSERT, UPDATE ON tutorial_seen TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights)'; END $$;
