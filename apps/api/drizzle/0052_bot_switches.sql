CREATE TABLE IF NOT EXISTS "bot_switches" (
	"id" serial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_bot_id" bigint,
	"to_bot_id" bigint NOT NULL,
	"reason" text NOT NULL,
	"by_user" bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_switches_at_idx" ON "bot_switches" USING btree ("at");
