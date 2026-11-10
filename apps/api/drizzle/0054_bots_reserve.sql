ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "account_id" integer;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "appearance_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bots" ADD CONSTRAINT "bots_account_id_creator_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."creator_accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bot_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"username_prefix" text DEFAULT 'gb' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"descriptions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"short_descriptions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"photo" text,
	"reserve_count" integer DEFAULT 2 NOT NULL,
	"reserve_every_days" integer DEFAULT 3 NOT NULL,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
