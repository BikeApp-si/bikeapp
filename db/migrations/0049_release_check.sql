-- O4 · The open Bike's daily look for a newer release (server/instance/updates.ts): the newest version GitHub
-- named, its page, and when Bike last asked. Nullable, so a Bike gone back to an older version still writes this row.
ALTER TABLE "instance_settings" ADD COLUMN "latest_version" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "latest_url" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "release_checked_at" timestamp with time zone;
