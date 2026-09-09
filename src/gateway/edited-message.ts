import type { TelegramMessage, TelegramUpdate } from "../shared/types.ts";

export function editedMessageText(update: TelegramUpdate): string | null {
  const message = update.edited_message;
  if (!message || typeof message.text !== "string") {
    return null;
  }
  const text = message.text.trim();
  return text || null;
}

export function editedInstructionPrompt(text: string): string {
  return [
    "Пользователь изменил свою инструкцию в Telegram. Обработай новую версию вместо предыдущей.",
    "",
    "Новая инструкция пользователя:",
    text,
  ].join("\n");
}

export function editedMessageForUpdate(update: TelegramUpdate): TelegramMessage | null {
  const message = update.edited_message;
  const hasOtherUpdateFields = Object.keys(update).some(
    (key) => key !== "update_id" && key !== "edited_message",
  );
  return !hasOtherUpdateFields && message && editedMessageText(update) !== null ? message : null;
}
