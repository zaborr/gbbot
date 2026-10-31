ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "checkout_fields" jsonb DEFAULT '{"contact":"required","name":"off","email":"off","phone":"off","notes":"off"}'::jsonb NOT NULL;--> statement-breakpoint
-- GBs that ship asked for the name, and optionally phone and notes: they keep asking that.
UPDATE "shops" SET "checkout_fields" = '{"contact":"required","name":"required","email":"off","phone":"optional","notes":"optional"}'::jsonb
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements("shipping_zones") AS z WHERE (z->>'isActive')::boolean
);
