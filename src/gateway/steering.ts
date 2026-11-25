import { messageText, withTelegramFormatting } from "../shared/message-text.ts";
import type { TelegramMessage } from "../shared/types.ts";
import { media } from "./database/records.ts";
import type { LoylexDatabase } from "./database.ts";
import { isOwnReply, promptWithQuote, steerCommandText } from "./triggers.ts";

export async function handleSteerCommand(
  database: LoylexDatabase,
  message: TelegramMessage,
  currentUserId: number | null,
  bot: { id: number; username?: string },
  respond: (text: string) => Promise<void>,
): Promise<boolean> {
  const steerText = steerCommandText(message, bot.id, bot.username);
  if (steerText !== null) {
    const jobs =
      steerText && currentUserId !== null && message.reply_to_message
        ? database.queueSteer(
            message.chat.id,
            message.reply_to_message.message_id,
            message.message_id,
            currentUserId,
            withTelegramFormatting(steerText, message),
            isOwnReply(message) ? { topicId: message.message_thread_id ?? null } : undefined,
          )
        : [];
    await respond(
      !steerText
        ? "Используй `/steer текст уточнения` в ответ на рабочее сообщение бота или на свой запрос в активной задаче."
        : jobs.length
          ? "Передаю уточнение в задачу…"
          : "Для этого сообщения нет активной задачи.",
    );
    return true;
  }
  return false;
}

export function queueOwnReplySteer(
  database: LoylexDatabase,
  message: TelegramMessage,
  currentUserId: number | null,
  prompt?: string,
): boolean {
  const reply = message.reply_to_message;
  if (!reply || !isOwnReply(message) || currentUserId === null) return false;
  const text = messageText(message).trim();
  if (!text || media(message).length > 0) return false;
  return (
    database.queueSteer(
      message.chat.id,
      reply.message_id,
      message.message_id,
      currentUserId,
      promptWithQuote(message, prompt ?? text),
      { topicId: message.message_thread_id ?? null },
    ).length > 0
  );
}
