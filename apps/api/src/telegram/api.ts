/** Minimal Telegram Bot API client covering the methods the shop needs. */

/** Inline keyboard under a message; `web_app` buttons open the Mini App. */
export interface InlineKeyboard {
  inline_keyboard: Array<
    Array<{ text: string; web_app?: { url: string }; url?: string; callback_data?: string }>
  >;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

export interface TelegramChatMember {
  status: string;
  /** For "restricted" members: whether they are still in the chat. */
  is_member?: boolean;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export class TelegramApi {
  constructor(
    private readonly botToken: string,
    private readonly baseUrl = 'https://api.telegram.org',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/bot${this.botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as TelegramResponse<T>;
    if (!data.ok || data.result === undefined) {
      throw new Error(`Telegram ${method} failed: ${data.description ?? res.statusText}`);
    }
    return data.result;
  }

  /** Sends a file to a chat. The user must have started the bot first. */
  async sendDocument(
    chatId: number,
    fileName: string,
    data: Buffer,
    contentType: string,
    caption?: string,
  ): Promise<unknown> {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption.slice(0, 1024));
    form.append('document', new Blob([new Uint8Array(data)], { type: contentType }), fileName);
    const res = await this.fetchImpl(`${this.baseUrl}/bot${this.botToken}/sendDocument`, {
      method: 'POST',
      body: form,
    });
    const body = (await res.json()) as TelegramResponse<unknown>;
    if (!body.ok) {
      throw new Error(`Telegram sendDocument failed: ${body.description ?? res.statusText}`);
    }
    return body.result;
  }

  /** Sends a plain-text message. The user must have started the bot first. */
  sendMessage(chatId: number, text: string, replyMarkup?: InlineKeyboard): Promise<unknown> {
    return this.call<unknown>('sendMessage', {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  /** Replaces the text (and buttons) of a message the bot sent. */
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup?: InlineKeyboard,
  ): Promise<unknown> {
    return this.call<unknown>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  /** Deletes a message the bot sent (Telegram allows it for 48 hours). */
  deleteMessage(chatId: number, messageId: number): Promise<unknown> {
    return this.call<unknown>('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  /** Stops the button's loading spinner, optionally with a short notice. */
  answerCallbackQuery(id: string, text?: string): Promise<unknown> {
    return this.call<unknown>('answerCallbackQuery', {
      callback_query_id: id,
      ...(text ? { text } : {}),
    });
  }

  /** Downloads a file someone sent to the bot (Telegram allows up to 20 MB). */
  async downloadFile(fileId: string): Promise<Buffer> {
    const file = await this.call<{ file_path?: string }>('getFile', { file_id: fileId });
    if (!file.file_path) throw new Error('Telegram getFile returned no path');
    const res = await this.fetchImpl(`${this.baseUrl}/file/bot${this.botToken}/${file.file_path}`);
    if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** A group, supergroup or channel, by numeric id or "@publicname". */
  getChat(chatId: number | string): Promise<TelegramChat> {
    return this.call<TelegramChat>('getChat', { chat_id: chatId });
  }

  /** Someone's membership of a chat. The bot must be in it (an admin, for channels). */
  getChatMember(chatId: number, userId: number): Promise<TelegramChatMember> {
    return this.call<TelegramChatMember>('getChatMember', { chat_id: chatId, user_id: userId });
  }

  /** Points Telegram's updates at this API, authenticated with `secret`. */
  setWebhook(url: string, secret: string, allowedUpdates: string[]): Promise<true> {
    return this.call<true>('setWebhook', {
      url,
      secret_token: secret,
      allowed_updates: allowedUpdates,
    });
  }

  /** The bot's default menu button, as set up in @BotFather. */
  getChatMenuButton(): Promise<{ type: string; text?: string; web_app?: { url: string } }> {
    return this.call('getChatMenuButton', {});
  }
}
