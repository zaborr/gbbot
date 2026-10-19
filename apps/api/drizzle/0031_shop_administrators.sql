ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "owner_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "owner_usernames" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "shops" SET
  "owner_ids" = jsonb_build_array("owner_id"),
  "admin_ids" = (
    SELECT coalesce(jsonb_agg(x ORDER BY i), '[]'::jsonb)
    FROM jsonb_array_elements("admin_ids") WITH ORDINALITY AS t(x, i)
    WHERE x <> to_jsonb("owner_id")
  )
WHERE "owner_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" DROP COLUMN IF EXISTS "owner_id";
