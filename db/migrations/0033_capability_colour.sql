-- Each capability's icon colour (0.4, M23). Kept with the capability, not in its file, so no Customize change, new
-- version, rename or reorder touches it. Existing capabilities get theirs once, in sidebar order per workspace,
-- cycling through the set in lib/cap-colors.ts.
ALTER TABLE "capabilities" ADD COLUMN "color" text DEFAULT 'violet' NOT NULL;--> statement-breakpoint
UPDATE "capabilities" c SET "color" = (ARRAY['violet', 'sky', 'green', 'amber', 'pink', 'teal', 'red'])[((o.n - 1) % 7) + 1]
FROM (SELECT "id", row_number() OVER (PARTITION BY "workspace_id" ORDER BY "position") AS n FROM "capabilities") o
WHERE o."id" = c."id";
