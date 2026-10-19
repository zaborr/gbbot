ALTER TYPE "public"."order_status" ADD VALUE 'shipped' BEFORE 'fulfilled';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tracking_number" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "status_note" text;