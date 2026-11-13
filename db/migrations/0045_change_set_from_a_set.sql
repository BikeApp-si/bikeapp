-- G1 · Sets as data. A change set that added an app set says which set and which version of it.
ALTER TABLE "change_sets" ADD COLUMN "set_name" text;--> statement-breakpoint
ALTER TABLE "change_sets" ADD COLUMN "set_version" integer;
