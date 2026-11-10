# Creator service

Internal service that acts as the creator accounts (Telegram user accounts):
signs them in, and later talks to @BotFather, posts to the notices channel
and adds the bot to groups. It keeps nothing on disk: the sessions are stored
(encrypted) by the API, which sends them with each request.

Only the API reaches it, on the Docker network (`http://creator:3100`); every
request carries a key derived from `JWT_SECRET`, which both read from `.env`.
