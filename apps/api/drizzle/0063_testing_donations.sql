ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'sale' NOT NULL;--> statement-breakpoint
ALTER TABLE "testings" ADD COLUMN IF NOT EXISTS "donation_product_id" uuid;--> statement-breakpoint
ALTER TABLE "testings" ADD COLUMN IF NOT EXISTS "donation_hours" integer DEFAULT 48 NOT NULL;--> statement-breakpoint
ALTER TABLE "testings" ADD COLUMN IF NOT EXISTS "donations_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "testings" ADD COLUMN IF NOT EXISTS "donations_done" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "testings" ADD CONSTRAINT "testings_donation_product_id_products_id_fk" FOREIGN KEY ("donation_product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "donation_unpaid" integer DEFAULT 0 NOT NULL;
