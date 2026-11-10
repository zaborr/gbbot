ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "notices_channel" text;--> statement-breakpoint
ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "notice_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "dm_admins" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "group_status" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_switches" ADD COLUMN IF NOT EXISTS "notices" jsonb;
