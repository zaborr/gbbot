ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "resume_status" text;--> statement-breakpoint
ALTER TABLE "testings" ADD COLUMN IF NOT EXISTS "donations_reminded" boolean DEFAULT false NOT NULL;
