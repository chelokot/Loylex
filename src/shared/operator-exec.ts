import type { TelegramMessage } from "./types.ts";

// This is deliberately a source-level allowlist. It is not read from an
// environment variable, a Telegram message, or an agent-controlled setting.
export const ADMIN_TELEGRAM_ID = 849670500;
export const ADMIN_EXEC_MAX_COMMAND_LENGTH = 8_192;

const execPattern = /^\/exec(?:@([a-z0-9_]+))?(?:[ \t]+([\s\S]*))?$/iu;

export type OperatorExecDecision = {
  authorized: boolean;
  command: string;
};

export function isOperatorExecContext(message: TelegramMessage): boolean {
  return (
    message.chat.type === "private" &&
    message.chat.id === ADMIN_TELEGRAM_ID &&
    message.from?.id === ADMIN_TELEGRAM_ID
  );
}

export function parseOperatorExecCommand(
  message: TelegramMessage,
  botUsername?: string,
): OperatorExecDecision | null {
  const text = (message.text ?? message.caption ?? "").trim();
  const match = text.match(execPattern);
  if (!match) {
    return null;
  }

  const mention = match[1];
  const mentionsThisBot =
    mention === undefined ||
    (botUsername !== undefined && mention.toLocaleLowerCase() === botUsername.toLocaleLowerCase());
  const authorized = mentionsThisBot && isOperatorExecContext(message);
  return { authorized, command: authorized ? (match[2] ?? "").trim() : "" };
}
