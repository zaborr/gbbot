ALTER TABLE "orders" ADD COLUMN "payment_method_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_check" jsonb;
