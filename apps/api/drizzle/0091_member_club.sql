ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "member_club" jsonb DEFAULT '{"groups":[],"userIds":[],"usernames":[]}'::jsonb NOT NULL;
