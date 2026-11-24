ALTER TABLE "testings" ADD COLUMN IF NOT EXISTS "invites" jsonb DEFAULT '[]'::jsonb NOT NULL;
