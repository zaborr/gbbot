CREATE TABLE IF NOT EXISTS "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hash" text NOT NULL,
	"kind" text NOT NULL,
	"telegram_id" bigint,
	"shop_id" uuid,
	"vip" text DEFAULT 'none' NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"uses" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "invites_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invites" ADD CONSTRAINT "invites_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invites_shop_idx" ON "invites" USING btree ("shop_id");
--> statement-breakpoint
ALTER TABLE "web_admins" ALTER COLUMN "totp_secret" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "web_admins" ADD COLUMN IF NOT EXISTS "link_state" text DEFAULT 'confirmed' NOT NULL;
--> statement-breakpoint
ALTER TABLE "web_admins" ADD COLUMN IF NOT EXISTS "linked_by" bigint;
--> statement-breakpoint
ALTER TABLE "web_admins" ADD COLUMN IF NOT EXISTS "invite_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "web_admins" ADD CONSTRAINT "web_admins_invite_id_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invites"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
