ALTER TABLE "shops" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "is_visible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "admin_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "wallets" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "wallets_initialized" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "shops" SET "slug" = trim(both '-' from regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g'));--> statement-breakpoint
UPDATE "shops" SET "slug" = 'shop' WHERE "slug" IS NULL OR "slug" = '';--> statement-breakpoint
UPDATE "shops" AS s SET "slug" = left(s."slug", 50) || '-' || substr(s."id"::text, 1, 8)
  WHERE EXISTS (SELECT 1 FROM "shops" AS o WHERE o."slug" = s."slug" AND o."id" < s."id");--> statement-breakpoint
ALTER TABLE "shops" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_slug_unique" UNIQUE("slug");
