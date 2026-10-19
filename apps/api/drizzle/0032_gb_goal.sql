ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "goal_amount" integer;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "goal_show_amount" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "goal_notified" integer DEFAULT 0 NOT NULL;
