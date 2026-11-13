-- M31 · Inbox: when each person last opened Updates, so later entries read as new. Null until they first open it.
ALTER TABLE "people" ADD COLUMN "inbox_seen_at" timestamp with time zone;
