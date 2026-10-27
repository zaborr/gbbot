ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "overpay_margin" integer DEFAULT 0 NOT NULL;
