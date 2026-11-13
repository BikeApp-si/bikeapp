-- AI credits (P1, Nov 5): each AI call is charged in credits (its Claude cost × 1.5, a credit $0.01, lib/pricing.ts),
-- kept beside its real cost. Each workspace has a plan and its start: a plan's month runs from that date; the first
-- month has 5,000 credits, the next 2,500 each, a trial 1,000 for 30 days, Enterprise an agreed number. Companies
-- already on Bike start on Business today (decided Nov 5); trial-link companies on the trial. Top-ups the Bike team
-- grants (agreed in writing; no checkout yet) are kept in ai_credit_grants, append-only like the Audit log.
-- ai_calls stays append-only (0023_locks): calls before this have credits 0, and every plan starts now, so they fall
-- before its first month; the cost report works their credits out from cost_usd.
ALTER TABLE "ai_calls" ADD COLUMN "credits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "plan" text DEFAULT 'trial' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "plan_started_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "plan_monthly_credits" integer;--> statement-breakpoint
UPDATE "workspaces" SET "plan" = CASE WHEN "trial" IS NULL THEN 'business' ELSE 'trial' END, "plan_started_at" = now();--> statement-breakpoint
CREATE TABLE "ai_credit_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"credits" integer NOT NULL,
	"kind" text NOT NULL,
	"note" text,
	"by" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_credit_grants" ADD CONSTRAINT "ai_credit_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_credit_grants_workspace_at" ON "ai_credit_grants" USING btree ("workspace_id","at");--> statement-breakpoint
ALTER TABLE ai_credit_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_credit_grants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_rows ON ai_credit_grants USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
--> statement-breakpoint
DO $$ BEGIN REVOKE ALL ON ai_credit_grants FROM PUBLIC; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host refuses changes to PUBLIC; new tables give PUBLIC nothing)'; END $$;
--> statement-breakpoint
DO $$ BEGIN GRANT SELECT ON ai_credit_grants TO bike_app; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Skipped (a managed host sets the app role''s rights)'; END $$;
--> statement-breakpoint
CREATE TRIGGER bike_no_update BEFORE UPDATE ON ai_credit_grants FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();
--> statement-breakpoint
CREATE TRIGGER bike_no_delete BEFORE DELETE ON ai_credit_grants FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();
--> statement-breakpoint
CREATE TRIGGER bike_no_truncate BEFORE TRUNCATE ON ai_credit_grants FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse();
