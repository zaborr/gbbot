// What the creator accounts do besides signing in. Each action gets the JSON
// body (with the account: apiId, apiHash, session) and some helpers.

import telegram from 'telegram';

const { CustomFile } = telegram.client.uploads;

const BOTFATHER = 'BotFather';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends something to @BotFather and waits for its answer (the first message
 * from it after ours). Its texts are matched loosely: they change little.
 */
async function ask(client, CreatorError, send) {
  const sent = await send();
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    await sleep(1200);
    const messages = await client.getMessages(BOTFATHER, { limit: 5, minId: sent.id });
    const reply = messages.filter((m) => !m.out).sort((a, b) => a.id - b.id)[0];
    if (reply) return reply.message ?? '';
  }
  throw new CreatorError('BOTFATHER_SILENT');
}

const say = (client, CreatorError, text) => ask(client, CreatorError, () => client.sendMessage(BOTFATHER, { message: text }));

/** BotFather's refusals that the API can act on. */
function refusal(text, CreatorError) {
  const wait = /try again in (\d+) seconds?/i.exec(text);
  if (wait) return new CreatorError('FLOOD_WAIT', { seconds: Number(wait[1]) });
  if (/more than 20 bots/i.test(text)) return new CreatorError('TOO_MANY_BOTS');
  if (/username is already taken/i.test(text)) return new CreatorError('USERNAME_TAKEN');
  if (/username is invalid|must end in .bot/i.test(text)) return new CreatorError('USERNAME_INVALID');
  return null;
}

/** Leaves BotFather at rest whatever happened before (an unfinished command). */
async function reset(client, CreatorError) {
  await say(client, CreatorError, '/cancel').catch(() => undefined);
}

export const actions = {
  /** A new bot: returns its token. */
  async '/botfather/newbot'({ account, name, username }, { withAccount, CreatorError }) {
    return withAccount(account, async (client) => {
      await reset(client, CreatorError);
      let text = await say(client, CreatorError, '/newbot');
      const early = refusal(text, CreatorError);
      if (early) throw early;
      text = await say(client, CreatorError, name);
      text = await say(client, CreatorError, username);
      const token = /(\d{5,}:[\w-]{30,})/.exec(text);
      if (token) return { token: token[1] };
      const refused = refusal(text, CreatorError);
      await reset(client, CreatorError);
      throw refused ?? new CreatorError('BOTFATHER_UNEXPECTED', { text: text.slice(0, 300) });
    });
  },

  /** The bot's profile photo (JPEG or PNG, base64). */
  async '/botfather/setuserpic'({ account, username, photo }, { withAccount, CreatorError }) {
    return withAccount(account, async (client) => {
      await reset(client, CreatorError);
      await say(client, CreatorError, '/setuserpic');
      let text = await say(client, CreatorError, `@${username}`);
      if (/invalid bot|not found/i.test(text)) throw new CreatorError('BOT_NOT_OWNED');
      const data = Buffer.from(photo, 'base64');
      text = await ask(client, CreatorError, () =>
        client.sendFile(BOTFATHER, { file: new CustomFile('photo.jpg', data.length, '', data) }),
      );
      if (!/success|updated/i.test(text)) {
        await reset(client, CreatorError);
        throw new CreatorError('BOTFATHER_UNEXPECTED', { text: text.slice(0, 300) });
      }
      return { ok: true };
    });
  },

  /** Deletes a bot of the account (a spare taken out). */
  async '/botfather/deletebot'({ account, username }, { withAccount, CreatorError }) {
    return withAccount(account, async (client) => {
      await reset(client, CreatorError);
      await say(client, CreatorError, '/deletebot');
      let text = await say(client, CreatorError, `@${username}`);
      if (/invalid bot|not found/i.test(text)) return { ok: true, gone: true };
      text = await say(client, CreatorError, 'Yes, I am totally sure.');
      if (!/done|gone|deleted/i.test(text)) {
        await reset(client, CreatorError);
        throw new CreatorError('BOTFATHER_UNEXPECTED', { text: text.slice(0, 300) });
      }
      return { ok: true };
    });
  },

  /** How users see a bot: gone, restricted, marked as scam or fake. */
  async '/resolve'({ account, username }, { withAccount, Api }) {
    return withAccount(account, async (client) => {
      try {
        const result = await client.invoke(new Api.contacts.ResolveUsername({ username }));
        const user =
          result.users.find((u) => (u.username ?? '').toLowerCase() === String(username).toLowerCase()) ??
          result.users[0];
        if (!user) return { found: false };
        return {
          found: true,
          deleted: Boolean(user.deleted),
          restricted: Boolean(user.restricted),
          scam: Boolean(user.scam),
          fake: Boolean(user.fake),
          reasons: (user.restrictionReason ?? []).map((r) => `${r.platform}: ${r.reason}`),
        };
      } catch (error) {
        if (error?.errorMessage === 'USERNAME_NOT_OCCUPIED') return { found: false };
        throw error;
      }
    });
  },

  /** A private message to someone (an administrator), by Telegram id or @. */
  async '/dm'({ account, to, text }, { withAccount, CreatorError }) {
    return withAccount(account, async (client) => {
      try {
        await client.sendMessage(to, { message: text });
      } catch {
        // The id is not known yet to this account: load its chats and contacts, then try again.
        await client.getDialogs({ limit: 200 }).catch(() => undefined);
        await client.invoke(new telegram.Api.contacts.GetContacts({ hash: telegram.helpers.returnBigInt(0) })).catch(() => undefined);
        try {
          await client.sendMessage(to, { message: text });
        } catch (error) {
          throw new CreatorError('DM_FAILED', { detail: error?.errorMessage ?? String(error?.message ?? error) });
        }
      }
      return { ok: true };
    });
  },

  /** Posts in the notices channel and makes the new bot an administrator there. */
  async '/channel/announce'({ account, channel, text, bot }, { withAccount, Api }) {
    return withAccount(account, async (client) => {
      await client.getDialogs({ limit: 200 }).catch(() => undefined);
      await client.sendMessage(channel, { message: text });
      let botAdmin = true;
      try {
        await client.invoke(
          new Api.channels.EditAdmin({
            channel,
            userId: bot,
            adminRights: new Api.ChatAdminRights({ postMessages: true, editMessages: true }),
            rank: '',
          }),
        );
      } catch {
        botAdmin = false;
      }
      return { ok: true, botAdmin };
    });
  },

  /**
   * Puts the bot in a group or channel of guests/VIPs, so it can see who is
   * in it: as administrator in channels, as member in groups.
   */
  async '/group/addbot'({ account, chatId, bot }, { withAccount, Api, CreatorError }) {
    return withAccount(account, async (client) => {
      await client.getDialogs({ limit: 500 }).catch(() => undefined);
      let entity;
      try {
        entity = await client.getEntity(chatId);
      } catch {
        throw new CreatorError('CHAT_NOT_JOINED');
      }
      if (entity instanceof Api.Chat) {
        await client.invoke(new Api.messages.AddChatUser({ chatId: entity.id, userId: bot, fwdLimit: 0 }));
        return { ok: true, as: 'member' };
      }
      if (entity.broadcast) {
        await client.invoke(
          new Api.channels.EditAdmin({ channel: entity, userId: bot, adminRights: new Api.ChatAdminRights({}), rank: '' }),
        );
        return { ok: true, as: 'admin' };
      }
      try {
        await client.invoke(new Api.channels.InviteToChannel({ channel: entity, users: [bot] }));
      } catch (error) {
        if (error?.errorMessage !== 'USER_ALREADY_PARTICIPANT') throw error;
      }
      return { ok: true, as: 'member' };
    });
  },
};
