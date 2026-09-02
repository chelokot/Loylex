import type { TelegramUpdate } from "./types.ts";

export const GDPR_EXCLUDED_CHAT_ID = 849670500;

type UnknownRecord = Record<string, unknown>;

function object(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function chatId(value: unknown): number | null {
  const record = object(value);
  const chat = object(record?.chat);
  return typeof chat?.id === "number" && Number.isSafeInteger(chat.id) ? chat.id : null;
}

function eventChatId(value: unknown): number | null {
  const direct = chatId(value);
  if (direct !== null) {
    return direct;
  }
  return chatId(object(value)?.message);
}

export function isGdprExcludedChat(chatId: number | null | undefined): boolean {
  return chatId === GDPR_EXCLUDED_CHAT_ID;
}

export function chatIdFromUpdate(update: TelegramUpdate): number | null {
  let firstChatId: number | null = null;
  for (const [key, value] of Object.entries(update)) {
    if (key === "update_id") {
      continue;
    }
    const currentChatId = eventChatId(value);
    if (isGdprExcludedChat(currentChatId)) {
      return currentChatId;
    }
    firstChatId ??= currentChatId;
  }
  return firstChatId;
}
