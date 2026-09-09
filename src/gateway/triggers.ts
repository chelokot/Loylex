import type { TelegramMessage } from "../shared/types.ts";

const prefixPattern =
  /^\s*(?:loylex|лойлекс|лойликс|чмох|чипа|сипа|лилс|лейлоекс|лейлодекс|лойдекс|лейдекс)(?=$|[\s:;,—–-])[\s:;,—–-]*/iu;
const stopPattern = /^\/stop(?:@[a-z0-9_]+)?$/iu;
const tasksPattern = /^\/tasks(?:@[a-z0-9_]+)?$/iu;
const cancelPattern = /^\/cancel_(\d+)(?:@([a-z0-9_]+))?$/iu;
const resumePattern = /^\/resume_(\d+)(?:@([a-z0-9_]+))?$/iu;
const helpPattern = /^\/(?:start|help)(?:@([a-z0-9_]+))?$/iu;
const newChatCommandPattern = /^\/newchat(?:@[a-z0-9_]+)?(?:\s+[\s\S]*)?$/iu;
const newChatPattern = /^\/newchat(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/iu;
const leylobucksPattern = /^\/(?:bucks|leylobucks)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/iu;
const testBumpPattern = /^\/test_bump(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/iu;
const leylobucksNaturalPattern = /^(?:лейлобаксы|лб)(?:\s+([\s\S]*))?$/iu;
const quizPattern = /^\/(?:quiz|викторина)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/iu;

export type LeylobucksCommand =
  | { kind: "status" }
  | { kind: "buy"; cost: 100 | 250 | 500 }
  | { kind: "toggle"; enabled: boolean }
  | { kind: "invalid" };

export type QuizCommand = { answer: string | null };

export type TestBumpCommand = { amount: number | null };

export type TriggerDecision = {
  prompt: string;
  kind: "prefix" | "private" | "reply";
};

function messageText(message: TelegramMessage): string {
  return message.text ?? message.caption ?? "";
}

export function promptWithQuote(message: TelegramMessage, prompt: string): string {
  const quote = message.quote?.text.trim();
  return quote ? `> In reply to: ${JSON.stringify(quote)}\n${prompt}` : prompt;
}

export function isSlashCommand(message: TelegramMessage): boolean {
  return messageText(message).trimStart().startsWith("/");
}

function mentionsAnotherBot(mention: string | undefined, botUsername: string | undefined): boolean {
  return Boolean(
    mention && botUsername && mention.toLocaleLowerCase() !== botUsername.toLocaleLowerCase(),
  );
}

export function isNewChatCommand(message: TelegramMessage): boolean {
  return newChatCommandPattern.test(messageText(message).trim());
}

export function newChatPrompt(message: TelegramMessage, botUsername?: string): string | null {
  const match = messageText(message).trim().match(newChatPattern);
  if (!match || mentionsAnotherBot(match[1], botUsername)) {
    return null;
  }
  return match[2]?.trim() || "Ответь на это сообщение.";
}

export function isStopCommand(
  message: TelegramMessage,
  botUserId: number,
  botUsername?: string,
): boolean {
  if (message.reply_to_message?.from?.id !== botUserId) {
    return false;
  }
  const text = messageText(message).trim();
  const match = text.match(stopPattern);
  if (!match) {
    return false;
  }
  const mention = text.slice("/stop".length).trim();
  if (!mention || !botUsername) {
    return true;
  }
  return mention.slice(1).toLocaleLowerCase() === botUsername.toLocaleLowerCase();
}

export function isTasksCommand(message: TelegramMessage, botUsername?: string): boolean {
  const text = messageText(message).trim();
  if (!tasksPattern.test(text)) {
    return false;
  }
  const mention = text.slice("/tasks".length).trim();
  if (!mention || !botUsername) {
    return true;
  }
  return mention.slice(1).toLocaleLowerCase() === botUsername.toLocaleLowerCase();
}

export function isHelpCommand(message: TelegramMessage, botUsername?: string): boolean {
  const text = messageText(message).trim();
  const match = text.match(helpPattern);
  if (!match) {
    return false;
  }
  const mention = match[1];
  return (
    !mention || !botUsername || mention.toLocaleLowerCase() === botUsername.toLocaleLowerCase()
  );
}

function commandMentionMatches(
  mention: string | undefined,
  botUsername: string | undefined,
): boolean {
  return (
    !mention || !botUsername || mention.toLocaleLowerCase() === botUsername.toLocaleLowerCase()
  );
}

function parseLeylobucksArgument(argument: string | undefined): LeylobucksCommand | null {
  const normalized = argument?.trim() ?? "";
  if (!normalized || /^(?:status|баланс|магазин|shop)$/iu.test(normalized)) {
    return { kind: "status" };
  }
  if (/^(?:on|вкл|включить)$/iu.test(normalized)) {
    return { kind: "toggle", enabled: true };
  }
  if (/^(?:off|выкл|выключить)$/iu.test(normalized)) {
    return { kind: "toggle", enabled: false };
  }
  const buy =
    normalized.match(/^(?:buy|купить)\s+(100|250|500)$/iu) ?? normalized.match(/^(100|250|500)$/u);
  const cost = Number.parseInt(buy?.[1] ?? "", 10);
  return cost === 100 || cost === 250 || cost === 500 ? { kind: "buy", cost } : { kind: "invalid" };
}

export function parseLeylobucksCommand(
  message: TelegramMessage,
  botUsername?: string,
): LeylobucksCommand | null {
  const text = messageText(message).trim();
  const slash = text.match(leylobucksPattern);
  if (slash) {
    return commandMentionMatches(slash[1], botUsername) ? parseLeylobucksArgument(slash[2]) : null;
  }
  const natural = text.match(leylobucksNaturalPattern);
  return natural ? parseLeylobucksArgument(natural[1]) : null;
}

export function parseTestBumpCommand(
  message: TelegramMessage,
  botUsername?: string,
): TestBumpCommand | null {
  const text = messageText(message).trim();
  const match = text.match(testBumpPattern);
  if (!match || !commandMentionMatches(match[1], botUsername)) {
    return null;
  }
  const rawAmount = match[2]?.trim() ?? "";
  if (!rawAmount) {
    return { amount: null };
  }
  const normalized = rawAmount.replace(/[,_\s]/gu, "");
  if (!/^\+?\d+$/u.test(normalized)) {
    return { amount: null };
  }
  const amount = Number(normalized);
  return Number.isSafeInteger(amount) && amount > 0 ? { amount } : { amount: null };
}

export function parseQuizCommand(
  message: TelegramMessage,
  botUsername?: string,
): QuizCommand | null {
  const text = messageText(message).trim();
  const match = text.match(quizPattern);
  if (!match || !commandMentionMatches(match[1], botUsername)) {
    return null;
  }
  const argument = match[2]?.trim() ?? "";
  return { answer: argument || null };
}

export function cancelTaskMessageId(message: TelegramMessage, botUsername?: string): number | null {
  const text = messageText(message).trim();
  const match = text.match(cancelPattern);
  if (!match) {
    return null;
  }
  const mention = match[2];
  if (mention && botUsername && mention.toLocaleLowerCase() !== botUsername.toLocaleLowerCase()) {
    return null;
  }
  const messageId = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(messageId) && messageId > 0 ? messageId : null;
}

export function resumeTaskMessageId(message: TelegramMessage, botUsername?: string): number | null {
  const text = messageText(message).trim();
  const match = text.match(resumePattern);
  if (!match) {
    return null;
  }
  const mention = match[2];
  if (mention && botUsername && mention.toLocaleLowerCase() !== botUsername.toLocaleLowerCase()) {
    return null;
  }
  const messageId = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(messageId) && messageId > 0 ? messageId : null;
}

export function detectTrigger(message: TelegramMessage, botUserId: number): TriggerDecision | null {
  const text = messageText(message);
  if (isSlashCommand(message)) {
    return null;
  }
  const prefix = text.match(prefixPattern);
  if (prefix) {
    const prompt = text.slice(prefix[0].length).trim();
    return { kind: "prefix", prompt: prompt || "Ответь на это сообщение." };
  }

  if (message.reply_to_message?.from?.id === botUserId) {
    return { kind: "reply", prompt: text.trim() || "Продолжай по вложению." };
  }

  if (message.chat.type === "private") {
    return { kind: "private", prompt: text.trim() || "Ответь на это сообщение." };
  }

  return null;
}
