ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "address_extras" jsonb DEFAULT '[]'::jsonb NOT NULL;
