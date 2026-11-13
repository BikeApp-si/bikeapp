-- M31 · Whether a row came in through an import: an import sends nothing in the Inbox (decided Nov 7). Filled from the
-- imports' Audit entries, which name their rows since M22; rows imported before that read as added.
ALTER TABLE "rows" ADD COLUMN "imported" boolean NOT NULL DEFAULT false;--> statement-breakpoint
UPDATE "rows" SET "imported" = true WHERE "id" IN (SELECT unnest("row_ids") FROM "audit_entries" WHERE "event" = 'import.done');
