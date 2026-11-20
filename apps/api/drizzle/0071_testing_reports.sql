CREATE TABLE IF NOT EXISTS "testing_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"testing_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"file_kind" text NOT NULL,
	"file_id" text NOT NULL,
	"file_name" text,
	"mime" text,
	"data" bytea,
	"size" integer,
	"uploaded_by" bigint,
	"delivered" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "testing_reports" ADD CONSTRAINT "testing_reports_testing_id_testings_id_fk" FOREIGN KEY ("testing_id") REFERENCES "public"."testings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_reports" ADD CONSTRAINT "testing_reports_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "testing_reports_shop_idx" ON "testing_reports" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "testing_reports_testing_idx" ON "testing_reports" USING btree ("testing_id");--> statement-breakpoint
INSERT INTO "testing_reports" ("testing_id", "shop_id", "kind", "file_kind", "file_id", "created_at")
SELECT "id", "shop_id", 'base', "report"->>'kind', "report"->>'fileId', COALESCE(("report"->>'sentAt')::timestamptz, now())
FROM "testings" WHERE "report" IS NOT NULL AND "report"->>'fileId' IS NOT NULL;--> statement-breakpoint
INSERT INTO "testing_reports" ("testing_id", "shop_id", "kind", "file_kind", "file_id", "created_at")
SELECT "id", "shop_id", 'extra', "extra_report"->>'kind', "extra_report"->>'fileId', COALESCE(("extra_report"->>'sentAt')::timestamptz, now())
FROM "testings" WHERE "extra_report" IS NOT NULL AND "extra_report"->>'fileId' IS NOT NULL;
