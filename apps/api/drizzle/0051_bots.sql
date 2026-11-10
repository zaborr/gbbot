CREATE TABLE IF NOT EXISTS "bots" (
	"id" bigint PRIMARY KEY NOT NULL,
	"username" text,
	"token" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"down_at" timestamp with time zone,
	"down_reason" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bots_status_idx" ON "bots" USING btree ("status");
