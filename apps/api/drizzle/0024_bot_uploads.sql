CREATE TABLE IF NOT EXISTS "bot_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"content" text NOT NULL,
	"shop_id" uuid,
	"shop_choices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bot_uploads" ADD CONSTRAINT "bot_uploads_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_uploads_expires_idx" ON "bot_uploads" USING btree ("expires_at");
