CREATE TABLE IF NOT EXISTS "creator_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"api_id" integer NOT NULL,
	"api_hash" text NOT NULL,
	"session" text,
	"status" text NOT NULL,
	"telegram_id" bigint,
	"username" text,
	"first_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone,
	"last_error" text
);
