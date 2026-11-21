ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "failed_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
