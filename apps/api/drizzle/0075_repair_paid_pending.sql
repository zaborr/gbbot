-- Orders paid in full but left waiting for a payment (a testing's unpaid part
-- taken off them without moving them back): they are paid, or sent again.
UPDATE "order_items" SET "donation_unpaid" = 0
WHERE "order_id" IN (
  SELECT "id" FROM "orders"
  WHERE "status" = 'pending' AND "amount_paid" > 0 AND "amount_paid" >= "total" AND "amount_submitted" = 0
);--> statement-breakpoint
UPDATE "orders" SET "status" = COALESCE("resume_status", 'paid')::order_status, "resume_status" = NULL, "updated_at" = now()
WHERE "status" = 'pending' AND "amount_paid" > 0 AND "amount_paid" >= "total" AND "amount_submitted" = 0;
