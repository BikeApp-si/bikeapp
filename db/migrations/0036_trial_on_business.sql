-- One plan with a free trial (decided Nov 5): there is no "trial" plan any more. A new company is on Business from
-- signup with 30 days free (1,000 AI credits); the Bike team marks it paid, and its paid months start then (5,000 the
-- first, 2,500 after). Unpaid after the trial, Bike stops building; work goes on. Companies on Business already are
-- marked paid; those that were on the trial keep its end date and stay unpaid.
ALTER TABLE "workspaces" ADD COLUMN "trial_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
UPDATE "workspaces" SET "trial_ends_at" = "plan_started_at" + interval '30 days' WHERE "plan" = 'trial';--> statement-breakpoint
UPDATE "workspaces" SET "paid_at" = now() WHERE "plan" <> 'trial';--> statement-breakpoint
UPDATE "workspaces" SET "plan" = 'business' WHERE "plan" = 'trial';--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "plan" SET DEFAULT 'business';
