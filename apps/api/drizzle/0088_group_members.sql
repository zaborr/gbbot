CREATE TABLE IF NOT EXISTS "group_members" (
	"chat_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_members_chat_id_user_id_pk" PRIMARY KEY("chat_id","user_id")
);
