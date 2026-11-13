-- Trial links (M10b): the link a sign-up came through, and the label of the link a workspace was created from
-- (null for invited founders and the seed). A trial workspace gets the smaller AI budget.
ALTER TABLE signups ADD COLUMN invite text;
--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN trial text;
