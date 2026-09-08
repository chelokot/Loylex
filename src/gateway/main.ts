import type { TelegramMessage } from "../shared/types.ts";
import { InboundAuditLog } from "./audit.ts";
import { loadGatewayConfig } from "./config.ts";
import { type LeylobucksEnqueueResult, LoylexDatabase } from "./database.ts";
import { feedbackAcknowledgement, isOperatorDislikeReaction } from "./feedback.ts";
import { responseOptions } from "./message-options.ts";
import { hasDanyaWrittenLoylexNameMistake } from "./name-reactions.ts";
import {
  helpMessage,
  leylobucksBlockedMessage,
  leylobucksInvalidCommandMessage,
  leylobucksPurchaseMessage,
  leylobucksQuizMessage,
  leylobucksStatusMessage,
  resumeUnavailableMessage,
  stopResultMessage,
} from "./presentation.ts";
import { GatewayServer } from "./server.ts";
import { sendTasks } from "./tasks.ts";
import { TelegramClient } from "./telegram.ts";
import {
  cancelTaskMessageId,
  detectTrigger,
  isHelpCommand,
  isNewChatCommand,
  isSlashCommand,
  isStopCommand,
  isTasksCommand,
  newChatPrompt,
  parseLeylobucksCommand,
  parseQuizCommand,
  promptWithQuote,
  resumeTaskMessageId,
} from "./triggers.ts";

const config = loadGatewayConfig();
const audit = new InboundAuditLog(config.auditPath);
await audit.assertReady();
const database = new LoylexDatabase(config.databasePath);
const telegram = new TelegramClient(config.botToken);
const bot = await telegram.getMe();

await telegram.call("deleteWebhook", { drop_pending_updates: false });
await telegram.setCommands();
const server = new GatewayServer(config, database, telegram);
server.start();

let stopping = false;
let offset = database.nextUpdateOffset();

function acknowledgeWork(message: TelegramMessage): void {
  void Promise.allSettled([
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

function userId(message: TelegramMessage): number | null {
  return Number.isSafeInteger(message.from?.id) ? (message.from?.id ?? null) : null;
}

function enqueueRequest(
  database: LoylexDatabase,
  updateId: number,
  message: TelegramMessage,
  prompt: string,
  qualityText: string,
  resumeThreadId: string | null,
  contextMode?: "full" | "delta" | "none",
): LeylobucksEnqueueResult {
  if (userId(message) !== null) {
    return database.enqueueWithLeylobucks(
      updateId,
      message,
      prompt,
      qualityText,
      resumeThreadId,
      contextMode,
    );
  }
  database.enqueue(updateId, message, prompt, resumeThreadId, contextMode);
  return { kind: "queued", economy: null };
}

async function sendInlineResponse(
  telegram: TelegramClient,
  message: TelegramMessage,
  markdown: string,
): Promise<void> {
  await telegram.sendRich(
    message.chat.id,
    markdown,
    responseOptions(message.chat.type, message.message_id, message.message_thread_id ?? null),
  );
}

async function poll(): Promise<void> {
  while (!stopping) {
    try {
      const updates = await telegram.getUpdates(offset, config.pollTimeoutSeconds);
      for (const update of updates) {
        await audit.append(update);
        const message = database.archiveUpdate(update);
        offset = update.update_id + 1;
        if (update.message_reaction && isOperatorDislikeReaction(update.message_reaction)) {
          const feedbackJobId = database.enqueueDislikeRecovery(update);
          if (feedbackJobId !== null) {
            const address = database.jobAddress(feedbackJobId);
            try {
              const acknowledgement = await telegram.sendRich(
                address.chatId,
                feedbackAcknowledgement(),
                responseOptions(address.chatType, address.messageId, address.threadId),
              );
              database.recordOutboundMessage(
                feedbackJobId,
                acknowledgement.message_id,
                database.jobThreadId(feedbackJobId),
              );
            } catch (error) {
              console.log(
                JSON.stringify({
                  level: "warn",
                  component: "poller",
                  event: "feedback_acknowledgement_unavailable",
                  jobId: feedbackJobId,
                  error: error instanceof Error ? error.message : String(error),
                }),
              );
            }
            console.log(
              JSON.stringify({
                level: "info",
                component: "poller",
                event: "dislike_feedback_queued",
                jobId: feedbackJobId,
                targetMessageId: update.message_reaction.message_id,
              }),
            );
          }
          continue;
        }
        const stopped = update.stopped_message_generation;
        if (stopped && Number.isSafeInteger(stopped.draft_id)) {
          const cancelledJobIds = database.cancelJobsForDraft(stopped.chat.id, stopped.draft_id);
          if (cancelledJobIds.length > 0) {
            console.log(
              JSON.stringify({
                level: "info",
                component: "poller",
                event: "draft_jobs_cancelled",
                jobIds: cancelledJobIds,
              }),
            );
          }
          await telegram.sendRich(
            stopped.chat.id,
            stopResultMessage(cancelledJobIds.length),
            responseOptions(stopped.chat.type, undefined, stopped.message_thread_id ?? null),
          );
          continue;
        }
        if (!message || message.from?.is_bot) {
          continue;
        }
        acknowledgeNameMistake(message);
        const currentUserId = userId(message);
        const leylobucksCommand = parseLeylobucksCommand(message, bot.username);
        if (leylobucksCommand && currentUserId !== null) {
          const markdown =
            leylobucksCommand.kind === "status"
              ? leylobucksStatusMessage(database.leylobucksStatus(currentUserId))
              : leylobucksCommand.kind === "buy"
                ? leylobucksPurchaseMessage(
                    database.purchaseLeylobucks(currentUserId, leylobucksCommand.cost),
                  )
                : leylobucksInvalidCommandMessage();
          await sendInlineResponse(telegram, message, markdown);
          continue;
        }
        const quizCommand = parseQuizCommand(message, bot.username);
        if (quizCommand && currentUserId !== null) {
          await sendInlineResponse(
            telegram,
            message,
            leylobucksQuizMessage(database.quizLeylobucks(currentUserId, quizCommand.answer)),
          );
          continue;
        }
        const cancelledMessageId = cancelTaskMessageId(message, bot.username);
        if (cancelledMessageId !== null) {
          const cancelledJobIds = database.cancelJobsForMessage(
            message.chat.id,
            cancelledMessageId,
          );
          if (cancelledJobIds.length > 0) {
            console.log(
              JSON.stringify({
                level: "info",
                component: "poller",
                event: "jobs_cancelled",
                jobIds: cancelledJobIds,
              }),
            );
          }
          await telegram.sendRich(message.chat.id, stopResultMessage(cancelledJobIds.length), {
            ...responseOptions(
              message.chat.type,
              message.message_id,
              message.message_thread_id ?? null,
            ),
          });
          continue;
        }
        if (isStopCommand(message, bot.id, bot.username)) {
          const cancelledJobIds = message.reply_to_message
            ? database.cancelJobsForMessage(message.chat.id, message.reply_to_message.message_id)
            : [];
          if (cancelledJobIds.length > 0) {
            console.log(
              JSON.stringify({
                level: "info",
                component: "poller",
                event: "jobs_cancelled",
                jobIds: cancelledJobIds,
              }),
            );
          }
          await telegram.sendRich(message.chat.id, stopResultMessage(cancelledJobIds.length), {
            ...responseOptions(
              message.chat.type,
              message.message_id,
              message.message_thread_id ?? null,
            ),
          });
          continue;
        }
        if (isTasksCommand(message, bot.username)) {
          await sendTasks(database, telegram, message);
          continue;
        }
        if (isHelpCommand(message, bot.username)) {
          await telegram.sendRich(message.chat.id, helpMessage(), {
            ...responseOptions(
              message.chat.type,
              message.message_id,
              message.message_thread_id ?? null,
            ),
          });
          continue;
        }
        const resumeMessageId = resumeTaskMessageId(message, bot.username);
        if (resumeMessageId !== null) {
          const status = currentUserId === null ? null : database.leylobucksStatus(currentUserId);
          if (status && status.balance < 0) {
            await sendInlineResponse(telegram, message, leylobucksBlockedMessage(status));
            continue;
          }
          const resumeThreadId = database.resumableThread(message.chat.id, resumeMessageId);
          if (resumeThreadId === null) {
            await telegram.sendRich(message.chat.id, resumeUnavailableMessage(), {
              ...responseOptions(
                message.chat.type,
                message.message_id,
                message.message_thread_id ?? null,
              ),
            });
          } else {
            const prompt = promptWithQuote(
              message,
              "Продолжи предыдущую задачу с того места, где она остановилась.",
            );
            const admission = enqueueRequest(
              database,
              update.update_id,
              message,
              prompt,
              message.text ?? message.caption ?? prompt,
              resumeThreadId,
            );
            if (admission.kind === "blocked") {
              await sendInlineResponse(
                telegram,
                message,
                leylobucksBlockedMessage(admission.statusView),
              );
            } else if (admission.kind === "queued") {
              acknowledgeWork(message);
            }
          }
          continue;
        }
        if (message.chat.type === "private" && isNewChatCommand(message)) {
          const status = currentUserId === null ? null : database.leylobucksStatus(currentUserId);
          if (status && status.balance < 0) {
            await sendInlineResponse(telegram, message, leylobucksBlockedMessage(status));
            continue;
          }
          const prompt = newChatPrompt(message, bot.username);
          if (prompt !== null) {
            const queuedPrompt = promptWithQuote(message, prompt);
            const admission = enqueueRequest(
              database,
              update.update_id,
              message,
              queuedPrompt,
              prompt,
              null,
              "none",
            );
            if (admission.kind === "blocked") {
              await sendInlineResponse(
                telegram,
                message,
                leylobucksBlockedMessage(admission.statusView),
              );
            } else if (admission.kind === "queued") {
              acknowledgeWork(message);
            }
          }
          continue;
        }
        if (isSlashCommand(message)) {
          continue;
        }
        const trigger = detectTrigger(message, bot.id);
        if (!trigger) {
          continue;
        }
        const status = currentUserId === null ? null : database.leylobucksStatus(currentUserId);
        if (status && status.balance < 0) {
          await sendInlineResponse(telegram, message, leylobucksBlockedMessage(status));
          continue;
        }
        const repliedThreadId = database.resumeThread(
          message.chat.id,
          message.reply_to_message?.message_id,
        );
        const resumeThreadId =
          repliedThreadId ??
          (message.chat.type === "private"
            ? database.latestContinuableThread(message.chat.id)
            : null);
        const prompt = promptWithQuote(message, trigger.prompt);
        const admission = enqueueRequest(
          database,
          update.update_id,
          message,
          prompt,
          trigger.prompt,
          resumeThreadId,
        );
        if (admission.kind === "blocked") {
          await sendInlineResponse(
            telegram,
            message,
            leylobucksBlockedMessage(admission.statusView),
          );
        } else if (admission.kind === "queued") {
          acknowledgeWork(message);
        }
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          component: "poller",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      await Bun.sleep(2_000);
    }
  }
}

function shutdown(): void {
  stopping = true;
  server.stop();
  database.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(JSON.stringify({ level: "info", bot: bot.username, offset }));
await poll();
