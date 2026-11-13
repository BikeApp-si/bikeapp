ALTER TABLE "people" ADD COLUMN "setup_role" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "street" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "address_region" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "what_it_does" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "business_model" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "products" text[];--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "holiday_country" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "fiscal_year_start" integer;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "setup" jsonb;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "setup_done_at" timestamp with time zone;--> statement-breakpoint
-- Workspaces made before setup 2b–2g existed count as set up.
UPDATE "workspaces" SET "setup_done_at" = "created_at";
