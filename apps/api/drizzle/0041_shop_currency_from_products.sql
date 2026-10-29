-- A GB's currency follows what its products are priced in (it was always USDC).
UPDATE "shops" SET "currency" = sub."currency"
FROM (
  SELECT DISTINCT ON ("shop_id") "shop_id", "currency"
  FROM "products"
  GROUP BY "shop_id", "currency"
  ORDER BY "shop_id", count(*) DESC
) AS sub
WHERE sub."shop_id" = "shops"."id";
