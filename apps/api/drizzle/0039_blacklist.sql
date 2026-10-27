ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "blacklist" jsonb DEFAULT '{"userIds":[],"usernames":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "blacklist" jsonb DEFAULT '{"userIds":[],"usernames":[]}'::jsonb NOT NULL;
