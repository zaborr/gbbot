ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "vip_order_fee" integer;--> statement-breakpoint
UPDATE "shops" SET "vip_order_fee" = 0 WHERE "vip_no_fee" = true;
