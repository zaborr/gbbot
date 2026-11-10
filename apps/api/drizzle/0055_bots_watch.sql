ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "watch_minutes" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "user_check_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "auto_switch" boolean DEFAULT true NOT NULL;
