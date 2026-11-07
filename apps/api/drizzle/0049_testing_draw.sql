ALTER TABLE "testings" ADD COLUMN IF NOT EXISTS "draw" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "donated_vials" jsonb DEFAULT '[]'::jsonb NOT NULL;
