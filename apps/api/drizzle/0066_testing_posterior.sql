ALTER TABLE "testings" ADD COLUMN IF NOT EXISTS "posterior" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "testings" DROP CONSTRAINT IF EXISTS "testings_product_variant_unique";
