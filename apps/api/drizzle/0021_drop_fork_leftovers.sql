ALTER TABLE "shops" DROP COLUMN IF EXISTS "wallets";--> statement-breakpoint
ALTER TABLE "shops" DROP COLUMN IF EXISTS "wallets_initialized";--> statement-breakpoint
ALTER TABLE "shops" DROP COLUMN IF EXISTS "bot_username";--> statement-breakpoint
ALTER TABLE "shops" DROP COLUMN IF EXISTS "stars_enabled";--> statement-breakpoint
ALTER TABLE "shops" ALTER COLUMN "currency" SET DEFAULT 'USDC';--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN IF EXISTS "payment_charge_id";
