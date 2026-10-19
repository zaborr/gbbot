ALTER TABLE "orders" ADD COLUMN "amount_paid" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "amount_submitted" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "stock_applied" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "change_request" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_log" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "orders" SET
  "amount_paid" = "total",
  "stock_applied" = true,
  "payment_log" = jsonb_build_array(jsonb_build_object(
    'type', 'payment',
    'amount', "total",
    'network', "payment_network",
    'txHash', "payment_tx_hash",
    'at', to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  ))
WHERE "status" IN ('paid', 'fulfilled');--> statement-breakpoint
UPDATE "orders" SET "amount_submitted" = "total" WHERE "status" = 'awaiting_payment';
