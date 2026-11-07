ALTER TABLE "testings" ADD COLUMN IF NOT EXISTS "settlement" jsonb;--> statement-breakpoint
ALTER TABLE "testings" ADD COLUMN IF NOT EXISTS "report" jsonb;--> statement-breakpoint
ALTER TABLE "testings" ADD COLUMN IF NOT EXISTS "report_request" jsonb;
