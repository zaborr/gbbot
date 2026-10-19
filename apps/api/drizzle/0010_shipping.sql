ALTER TABLE "shops" ADD COLUMN "shipping_zones" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "address_public_key" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "address_key_fingerprint" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_zone_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "encrypted_address" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "address_key_fingerprint" text;
