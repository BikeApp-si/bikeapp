-- A view's layout and grouping (0.4, M20): a table or a board by step, and the column its rows are grouped by.
ALTER TABLE "views" ADD COLUMN "layout" text DEFAULT 'table' NOT NULL;--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "group_by" jsonb;
