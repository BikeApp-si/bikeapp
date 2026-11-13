-- Where a rule came from (server/kernel/rule-set.ts). Every rule so far is in a capability's file: the one the
-- wait, run or AI step is on.
DROP INDEX "rule_runs_once";--> statement-breakpoint
ALTER TABLE "ai_steps" ADD COLUMN "rule_source" text;--> statement-breakpoint
ALTER TABLE "rule_runs" ADD COLUMN "rule_source" text;--> statement-breakpoint
ALTER TABLE "waits" ADD COLUMN "rule_source" text;--> statement-breakpoint
UPDATE "ai_steps" SET "rule_source" = 'capability:' || "capability_id";--> statement-breakpoint
UPDATE "rule_runs" SET "rule_source" = 'capability:' || "capability_id";--> statement-breakpoint
UPDATE "waits" SET "rule_source" = 'capability:' || "capability_id";--> statement-breakpoint
ALTER TABLE "ai_steps" ALTER COLUMN "rule_source" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "rule_runs" ALTER COLUMN "rule_source" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "waits" ALTER COLUMN "rule_source" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "rule_runs_once" ON "rule_runs" USING btree ("rule_source","rule_id","row_id","on_date");
