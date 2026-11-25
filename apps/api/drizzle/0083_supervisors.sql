ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "supervisor_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "supervisor_usernames" jsonb DEFAULT '[]'::jsonb NOT NULL;
