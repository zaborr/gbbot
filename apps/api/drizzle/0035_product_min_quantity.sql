ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "min_quantity" integer DEFAULT 1 NOT NULL;
