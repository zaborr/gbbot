ALTER TABLE "testings" ADD COLUMN IF NOT EXISTS "per_unit" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "testing_entries" ADD COLUMN IF NOT EXISTS "extra" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cart_testings" ADD COLUMN IF NOT EXISTS "extra" integer DEFAULT 0 NOT NULL;
