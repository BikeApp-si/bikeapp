DROP INDEX "rule_runs_once";--> statement-breakpoint
ALTER TABLE "rule_runs" ADD COLUMN "base_date" date;--> statement-breakpoint
-- Runs recorded before base dates existed keep their own date as the base (db:reset re-seeds them properly).
UPDATE "rule_runs" SET "base_date" = "on_date";--> statement-breakpoint
ALTER TABLE "rule_runs" ALTER COLUMN "base_date" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "rule_runs_once" ON "rule_runs" USING btree ("rule_source","rule_id","row_id","base_date");
