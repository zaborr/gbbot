ALTER TABLE "orders" ADD COLUMN "payment_network" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_tx_hash" text;
