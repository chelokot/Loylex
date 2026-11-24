import type { TelegramMessage } from "../shared/types.ts";
import type { LoylexDatabase } from "./database.ts";

export function isProgressCommand(message: TelegramMessage, botUsername?: string): boolean {
  const match = (message.text ?? "").trim().match(/^\/progress(?:@([a-z0-9_]+))?$/iu);
  return Boolean(
    match && (!match[1] || !botUsername || match[1].toLowerCase() === botUsername.toLowerCase()),
  );
}

export async function handleProgressCommand(
  database: LoylexDatabase,
  message: TelegramMessage,
  botUsername: string | undefined,
  userId: number | null,
  send: (text: string) => Promise<void>,
): Promise<boolean> {
  if (!isProgressCommand(message, botUsername)) return false;
  if (userId !== null) {
    const enabled = database.toggleProgress(userId);
    await send(
      enabled
        ? "Ход работы включён для твоих запросов."
        : "Ход работы выключен для твоих запросов. Буду присылать только итоговый ответ.",
    );
  }
  return true;
}
