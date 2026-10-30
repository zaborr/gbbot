ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "allow_guests" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "guest_list" jsonb DEFAULT '{"groups":[],"userIds":[],"usernames":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "use_global_guests" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "guest_list" jsonb DEFAULT '{"groups":[],"userIds":[],"usernames":[]}'::jsonb NOT NULL;
