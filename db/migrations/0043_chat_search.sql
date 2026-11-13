-- M33 · Searching chats: full-text over chat titles and message texts. RLS already shows a person only their own
-- chats and messages; the search reads through it.
ALTER TABLE "chats" ADD COLUMN "search" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, ''))) STORED;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "search" tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;--> statement-breakpoint
CREATE INDEX "chats_search" ON "chats" USING gin ("search");--> statement-breakpoint
CREATE INDEX "messages_search" ON "messages" USING gin ("search");
