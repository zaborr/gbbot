ALTER TABLE "shops" ADD COLUMN "order_fee" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "order_fee_label" text DEFAULT 'Service fee' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fee" integer DEFAULT 0 NOT NULL;
