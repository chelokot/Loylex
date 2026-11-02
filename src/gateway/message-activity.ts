import type { TelegramMessage, TelegramUpdate } from "../shared/types.ts";
import { hasDanyaWrittenLoylexNameMistake } from "./name-reactions.ts";
import type { TelegramClient } from "./telegram.ts";
import { detectTrigger, isSlashCommand } from "./triggers.ts";

export function createMessageActivity(telegram: TelegramClient) {
  function acknowledgeWork(message: TelegramMessage): Promise<void> {
    return Promise.allSettled([
      telegram.sendTyping(message.chat.id, message.message_thread_id ?? null),
      telegram.setThinkingReaction(message.chat.id, message.message_id),
    ]).then((results) => {
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        console.log(
          JSON.stringify({
            level: "warn",
            component: "poller",
            event: "telegram_activity_unavailable",
            messageId: message.message_id,
            failures: failures.map((result) =>
              result.reason instanceof Error ? result.reason.message : String(result.reason),
            ),
          }),
        );
      }
    });
  }

  function earlyAcknowledgementMessage(
    update: TelegramUpdate,
    botUserId: number,
  ): TelegramMessage | null {
    const message = update.message;
    if (!message || message.from?.is_bot || isSlashCommand(message)) {
      return null;
    }
    return detectTrigger(message, botUserId) ? message : null;
  }

  function clearEarlyThinkingReaction(
    message: TelegramMessage,
    acknowledgement: Promise<void> | null,
  ): void {
    if (acknowledgement === null) {
      return;
    }
    void acknowledgement.then(() =>
      telegram.clearMessageReaction(message.chat.id, message.message_id).catch((error) => {
        console.log(
          JSON.stringify({
            level: "warn",
            component: "poller",
            event: "early_thinking_reaction_clear_unavailable",
            messageId: message.message_id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }),
    );
  }

  function acknowledgeNameMistake(message: TelegramMessage): void {
    if (!hasDanyaWrittenLoylexNameMistake(message)) {
      return;
    }
    void telegram.setMessageReaction(message.chat.id, message.message_id, "🥴").catch((error) => {
      console.log(
        JSON.stringify({
          level: "warn",
          component: "poller",
          event: "name_mistake_reaction_unavailable",
          messageId: message.message_id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }

  return {
    acknowledgeWork,
    earlyAcknowledgementMessage,
    clearEarlyThinkingReaction,
    acknowledgeNameMistake,
  };
}
