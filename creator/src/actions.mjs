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
};
