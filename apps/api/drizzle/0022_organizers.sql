ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "owner_id" bigint;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "admin_usernames" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "organizer_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "organizer_usernames" jsonb DEFAULT '[]'::jsonb NOT NULL;
