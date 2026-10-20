import { requestWriteAccess } from '@telegram-apps/sdk-react';

let asked = false;

/**
 * Asks (once per session) for permission for the bot to message the user, so
 * order updates and exported files reach them even if they never pressed
 * Start. Telegram shows no popup when permission was already given.
 */
export async function askWriteAccess(): Promise<void> {
  if (asked) return;
  asked = true;
  try {
    if (requestWriteAccess.isAvailable()) await requestWriteAccess();
  } catch {
    // Declined or not supported: the shop keeps working without messages.
  }
}
