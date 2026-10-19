ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "vip_price" integer;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN IF NOT EXISTS "vip_price" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "is_vip" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "vip_no_fee" boolean DEFAULT false NOT NULL;
