import type { TelegramMessage } from "./types.ts";

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

/**
 * Returns the operator-compatible identity without trusting a forwarded origin.
 * Imported Telegram data may encode the sender ID in a numeric last name.
 */
export function telegramUserIdWithoutForward(message: TelegramMessage): number | null {
  const numericLastName = Number(message.from?.last_name);
  return !Number.isNaN(numericLastName) ? numericLastName : (message.from?.id ?? null);
}
