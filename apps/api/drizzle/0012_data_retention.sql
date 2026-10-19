CREATE TABLE "platform_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"address_retention_days" integer DEFAULT 30 NOT NULL,
	"cart_retention_days" integer DEFAULT 30 NOT NULL,
	"inactive_user_days" integer DEFAULT 30 NOT NULL,
	"last_retention_run_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "last_name";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "photo_url";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "is_premium";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_user_id_users_telegram_id_fk";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_telegram_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("telegram_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "anonymized_at" timestamp with time zone;--> statement-breakpoint
UPDATE "orders" SET "closed_at" = "updated_at" WHERE "status" IN ('fulfilled', 'cancelled');
