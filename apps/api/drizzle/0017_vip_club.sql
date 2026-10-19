ALTER TABLE "shops" ADD COLUMN "vip_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "vip_club" jsonb DEFAULT '{"groups":[],"userIds":[],"usernames":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "use_global_vip_club" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "vip_club" jsonb DEFAULT '{"groups":[],"userIds":[],"usernames":[]}'::jsonb NOT NULL;
