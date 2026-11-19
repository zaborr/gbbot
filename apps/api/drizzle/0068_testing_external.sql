ALTER TABLE "testings" ADD COLUMN IF NOT EXISTS "allow_external" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "external" boolean DEFAULT false NOT NULL;
