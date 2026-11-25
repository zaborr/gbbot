ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "label" jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_labels" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"mime" text NOT NULL,
	"file_name" text NOT NULL,
	"data" bytea NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_labels" ADD CONSTRAINT "order_labels_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
