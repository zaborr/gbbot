CREATE TABLE IF NOT EXISTS "expiring_bot_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" bigint NOT NULL,
	"message_id" integer NOT NULL,
	"delete_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expiring_bot_messages_delete_idx" ON "expiring_bot_messages" USING btree ("delete_at");
