ALTER TABLE "web_admins" ADD COLUMN IF NOT EXISTS "role" text DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE "web_admins" ADD COLUMN IF NOT EXISTS "telegram_id" bigint;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "web_admins" ADD CONSTRAINT "web_admins_telegram_id_users_telegram_id_fk" FOREIGN KEY ("telegram_id") REFERENCES "public"."users"("telegram_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "web_admins" ADD CONSTRAINT "web_admins_telegram_id_unique" UNIQUE("telegram_id");
EXCEPTION
 WHEN duplicate_table THEN null;
 WHEN duplicate_object THEN null;
END $$;
