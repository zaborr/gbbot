ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "testing" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "testings" ADD COLUMN IF NOT EXISTS "notified_tiers" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "testing_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"testing_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"user_id" bigint,
	"amount" integer NOT NULL,
	"volunteer" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "testing_entries_testing_order_unique" UNIQUE("testing_id","order_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cart_testings" (
	"cart_id" uuid NOT NULL,
	"testing_id" uuid NOT NULL,
	"volunteer" boolean DEFAULT false NOT NULL,
	CONSTRAINT "cart_testings_cart_id_testing_id_pk" PRIMARY KEY("cart_id","testing_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "testing_entries" ADD CONSTRAINT "testing_entries_testing_id_testings_id_fk" FOREIGN KEY ("testing_id") REFERENCES "public"."testings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "testing_entries" ADD CONSTRAINT "testing_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "testing_entries" ADD CONSTRAINT "testing_entries_user_id_users_telegram_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("telegram_id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cart_testings" ADD CONSTRAINT "cart_testings_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cart_testings" ADD CONSTRAINT "cart_testings_testing_id_testings_id_fk" FOREIGN KEY ("testing_id") REFERENCES "public"."testings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "testing_entries_order_idx" ON "testing_entries" USING btree ("order_id");
