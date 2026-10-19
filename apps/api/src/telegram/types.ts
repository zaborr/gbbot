/** The Telegram Update fields the bot uses. */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    chat?: { id: number; type: string };
    from?: { id: number; first_name?: string; language_code?: string };
    text?: string;
    /** A file sent to the bot. */
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  };
  /** Someone tapped one of the bot's inline buttons. */
  callback_query?: {
    id: string;
    from: { id: number; first_name?: string; language_code?: string };
    data?: string;
    message?: { message_id: number; chat: { id: number; type: string } };
  };
  /** The bot was added to, or removed from, a chat. */
  my_chat_member?: {
    chat: { id: number; type: string; title?: string; username?: string };
    from: { id: number; first_name?: string; language_code?: string };
    new_chat_member: { status: string };
  };
}
