import { messageText } from "../../shared/message-text.ts";
import type {
  JsonObject,
  JsonValue,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "../../shared/types.ts";
import type { LeylobucksQuizQuestion } from "../leylobucks.ts";
import type {
  ArchivedMessage,
  ArchivedMessageRow,
  LeylobucksQuizQuestionView,
  LeylobucksQuizReview,
  SearchResult,
  SearchRow,
  UnknownRecord,
  UsageAggregateRow,
  UsageTotals,
} from "./types.ts";

export function usageTotals(row: UsageAggregateRow): UsageTotals {
  const inputTokens = row.input_tokens ?? 0;
  const cachedInputTokens = row.cached_input_tokens ?? 0;
  return {
    jobs: row.jobs,
    meteredJobs: row.metered_jobs,
    unmeteredJobs: Math.max(row.jobs - row.metered_jobs, 0),
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens: row.cache_write_input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    reasoningOutputTokens: row.reasoning_output_tokens ?? 0,
    totalTokens: row.total_tokens ?? 0,
    nonCachedInputTokens: Math.max(inputTokens - cachedInputTokens, 0),
  };
}

export function object(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

export function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseObject(value: string): UnknownRecord {
  try {
    return object(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

export function forwardOrigin(rawJson: string): JsonObject | null {
  const raw = parseObject(rawJson);
  const origin = object(raw.forward_origin);
  return origin as JsonObject | null;
}

export function nestedAuthor(message: UnknownRecord): string {
  const sender = object(message.from) ?? object(message.sender_chat);
  if (!sender) {
    return "unknown";
  }
  const username = stringField(sender.username);
  const name = [stringField(sender.first_name), stringField(sender.last_name)]
    .filter((part): part is string => part !== null)
    .join(" ");
  return username ? `${name || username} (@${username})` : name || "unknown";
}

export function searchResult(row: SearchRow): SearchResult {
  const result: SearchResult = {
    chatId: row.chat_id,
    messageId: row.message_id,
    date: row.date,
    userId: row.from_user_id,
    author: row.from_username
      ? `${row.from_display_name ?? row.from_username} (@${row.from_username})`
      : (row.from_display_name ?? "unknown"),
    text: row.text || messageText(parseObject(row.raw_json)),
  };
  const origin = forwardOrigin(row.raw_json);
  return origin === null ? result : { ...result, forwardOrigin: origin };
}

export function archivedMessage(row: ArchivedMessageRow): ArchivedMessage {
  const raw = parseObject(row.raw_json) as unknown as JsonObject;
  const origin = forwardOrigin(row.raw_json);
  return {
    chatId: row.chat_id,
    messageId: row.message_id,
    date: row.date,
    userId: row.from_user_id,
    author: row.from_username
      ? `${row.from_display_name ?? row.from_username} (@${row.from_username})`
      : (row.from_display_name ?? "unknown"),
    text: row.text || messageText(parseObject(row.raw_json)),
    replyToMessageId: row.reply_to_message_id,
    mediaGroupId: row.media_group_id,
    source: row.source as ArchivedMessage["source"],
    media: JSON.parse(row.media_json) as JsonValue[],
    raw,
    ...(origin === null ? {} : { forwardOrigin: origin }),
  };
}

export function messageReference(message: UnknownRecord, label: string): string | null {
  const messageId = numberField(message.message_id);
  if (messageId === null) {
    return null;
  }
  const text = messageText(message);
  const attachments: JsonValue[] = [];
  for (const key of ["photo", "document", "audio", "video", "voice", "animation"]) {
    const value = message[key];
    if (value) {
      attachments.push({ kind: key, value: value as JsonValue });
    }
  }
  const mediaText = attachments.length > 0 ? ` attachments=${JSON.stringify(attachments)}` : "";
  return `${label} #${messageId} ${nestedAuthor(message)}: ${text}${mediaText}`;
}

export function rawRelations(rawJson: string): string {
  const raw = parseObject(rawJson);
  const relations: string[] = [];
  const quote = object(raw.quote);
  const quoteText = quote ? stringField(quote.text) : null;
  if (quoteText) {
    relations.push(`quote=${JSON.stringify(quoteText.slice(0, 1_000))}`);
  }
  const externalReply = object(raw.external_reply);
  const externalId = externalReply ? numberField(externalReply.message_id) : null;
  if (externalId !== null) {
    relations.push(`external_reply=#${externalId}`);
  }
  const forward = forwardOrigin(rawJson);
  if (forward) {
    const origin =
      object(forward.sender_user) ?? object(forward.sender_chat) ?? object(forward.chat) ?? forward;
    const originName =
      stringField(origin.username) ??
      ([stringField(origin.first_name), stringField(origin.last_name)]
        .filter((part): part is string => part !== null)
        .join(" ") ||
        stringField(origin.title) ||
        stringField(forward.sender_user_name) ||
        stringField(origin.type) ||
        "unknown");
    relations.push(
      `forwarded_from=${JSON.stringify(originName)} forward_origin=${JSON.stringify(forward)}`,
    );
  }
  return relations.join(" ");
}

export function eventType(update: TelegramUpdate): string {
  return Object.keys(update).find((key) => key !== "update_id") ?? "unknown";
}

export function displayNameForUser(user: TelegramUser): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || "unknown";
}

export function media(message: TelegramMessage): JsonValue[] {
  const values: JsonValue[] = [];
  for (const key of ["photo", "document", "audio", "video", "voice", "animation"] as const) {
    const value = message[key];
    if (value) {
      values.push({ kind: key, value: value as JsonValue });
    }
  }
  return values;
}

export function jobMedia(message: TelegramMessage): JsonValue[] {
  return [...media(message), ...(message.reply_to_message ? media(message.reply_to_message) : [])];
}

export function leylobucksQuestionView(
  question: LeylobucksQuizQuestion,
): LeylobucksQuizQuestionView {
  return {
    category: question.category,
    prompt: question.prompt,
    options: question.options,
    correctIndex: question.correctIndex,
  };
}

export function parseQuizAnswers(value: string): Array<number | null> {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map((answer) =>
          typeof answer === "number" && Number.isSafeInteger(answer) ? answer : null,
        )
      : [];
  } catch {
    return [];
  }
}

export function quizReview(
  questions: readonly LeylobucksQuizQuestion[],
  answers: readonly (number | null)[],
): LeylobucksQuizReview[] {
  return questions.map((question, questionIndex) => {
    const answerIndex = answers[questionIndex] ?? null;
    return {
      question: leylobucksQuestionView(question),
      answerIndex,
      correct: answerIndex === question.correctIndex,
    };
  });
}
