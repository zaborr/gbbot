ALTER TABLE "web_admins" ADD COLUMN IF NOT EXISTS "notices_seen_id" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "web_notices" (
	"id" serial PRIMARY KEY NOT NULL,
	"shop_id" uuid,
	"texts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "web_notices" ADD CONSTRAINT "web_notices_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "web_notices_created_at_idx" ON "web_notices" USING btree ("created_at");
