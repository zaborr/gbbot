ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "ship_units" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN IF NOT EXISTS "ship_units" integer;
