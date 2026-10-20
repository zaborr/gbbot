UPDATE "shops" SET "currency" = 'USDC', "stars_enabled" = false WHERE "currency" = 'XTR';--> statement-breakpoint
UPDATE "products" SET "currency" = 'USDC' WHERE "currency" = 'XTR';
