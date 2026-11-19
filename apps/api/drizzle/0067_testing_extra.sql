ALTER TABLE "testings" ADD COLUMN IF NOT EXISTS "extra_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "testings" ADD COLUMN IF NOT EXISTS "extra_min" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "testings" ADD COLUMN IF NOT EXISTS "extra_signup_hours" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "testings" ADD COLUMN IF NOT EXISTS "extra_pay_hours" integer DEFAULT 48 NOT NULL;--> statement-breakpoint
ALTER TABLE "testings" ADD COLUMN IF NOT EXISTS "extra" jsonb;--> statement-breakpoint
ALTER TABLE "testings" ADD COLUMN IF NOT EXISTS "extra_product_id" uuid;--> statement-breakpoint
ALTER TABLE "testings" ADD COLUMN IF NOT EXISTS "extra_report" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "testings" ADD CONSTRAINT "testings_extra_product_id_products_id_fk" FOREIGN KEY ("extra_product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "testing_extra_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"testing_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"user_id" bigint,
	"cap" integer NOT NULL,
	"share" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'signed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "testing_extra_members_testing_order_unique" UNIQUE("testing_id","order_id")
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "testing_extra_members" ADD CONSTRAINT "testing_extra_members_testing_id_testings_id_fk" FOREIGN KEY ("testing_id") REFERENCES "public"."testings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "testing_extra_members" ADD CONSTRAINT "testing_extra_members_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "testing_extra_members" ADD CONSTRAINT "testing_extra_members_user_id_users_telegram_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("telegram_id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
