ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "external_testing_id" uuid;--> statement-breakpoint
UPDATE "orders" SET "external_testing_id" = e."testing_id" FROM "testing_entries" e WHERE e."order_id" = "orders"."id" AND "orders"."external" = true AND "orders"."external_testing_id" IS NULL;
