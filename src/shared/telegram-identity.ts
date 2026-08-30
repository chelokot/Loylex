import type { TelegramMessage } from "./types.ts";

/**
 * Returns the direct Telegram sender. Use this for authorization decisions;
 * forwarded origins and display-name fields are deliberately ignored.
 */
export function telegramSenderId(message: TelegramMessage): number | null {
  return message.from?.id ?? null;
}

/**
 * Returns the normalized identity used in archived context and job metadata.
 * This intentionally preserves legacy handling of imported/forwarded messages.
 */
export function telegramUserId(message: TelegramMessage): number | null {
  const numericLastName = Number(message.from?.last_name);
  return !Number.isNaN(numericLastName)
    ? numericLastName
    : (message.forward_origin?.sender_user?.id ?? message.from?.id ?? null);
}
