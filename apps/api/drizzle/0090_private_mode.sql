ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "private_mode" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "account_deadline" timestamp with time zone;
