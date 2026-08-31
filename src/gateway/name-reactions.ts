import type { TelegramMessage } from "../shared/types.ts";

export const DANYA_TELEGRAM_USER_ID = 544344992;

export const WRONG_LOYLEX_NAME_VARIANTS = ["лейло", "лейлоекс", "лейлодекс", "лойдекс"] as const;

const wrongNamePattern =
  /(?:^|[^\p{L}\p{N}_])(?:лейлоекс|лейлодекс|лойдекс|лейло)(?=$|[^\p{L}\p{N}_])/iu;

export function hasDanyaWrittenLoylexNameMistake(message: TelegramMessage): boolean {
  if (message.from?.id !== DANYA_TELEGRAM_USER_ID) {
    return false;
  }
  return wrongNamePattern.test(message.text ?? message.caption ?? "");
}
