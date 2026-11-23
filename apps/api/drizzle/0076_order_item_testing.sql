ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "testing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "order_items" SET "testing" = true FROM "products"
WHERE "products"."id" = "order_items"."product_id" AND "products"."kind" <> 'sale';
