ALTER TABLE "products" ADD COLUMN "price_tiers" jsonb DEFAULT '[]'::jsonb NOT NULL;
