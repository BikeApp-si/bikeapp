-- M26 · Fuller Settings: how a company writes numbers and dates. Empty means the default (1,234,567 and
-- "Nov 14, 2026"), so every company made before reads as it did.
ALTER TABLE "workspaces" ADD COLUMN "number_grouping" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "date_style" text;
