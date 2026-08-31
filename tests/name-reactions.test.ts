import { expect, test } from "bun:test";
import {
  DANYA_TELEGRAM_USER_ID,
  hasDanyaWrittenLoylexNameMistake,
  WRONG_LOYLEX_NAME_VARIANTS,
} from "../src/gateway/name-reactions.ts";
import type { TelegramMessage } from "../src/shared/types.ts";

function message(text: string, userId = DANYA_TELEGRAM_USER_ID): TelegramMessage {
  return {
    message_id: 1,
    date: 1,
    chat: { id: -10042, type: "supergroup" },
    from: { id: userId, is_bot: false, first_name: "Daniel" },
    text,
  };
}

test("keeps all misspellings found in the recent Telegram window", () => {
  expect(WRONG_LOYLEX_NAME_VARIANTS).toEqual([
    "лейло",
    "лейлик",
    "лейлоекс",
    "лейлодекс",
    "лойдекс",
  ]);
});

test.each([
  "Лейло",
  "ЛЕЙЛИК",
  "ЛЕЙЛОЕКС",
  "ЛейлоДекс",
  "лОйДеКс",
])("matches Danya's name misspelling case-insensitively: %s", (text) => {
  expect(hasDanyaWrittenLoylexNameMistake(message(text))).toBe(true);
});

test.each([
  "Лойлекс",
  "геймплей",
  "лейлон",
  "Лейлоексный",
])("does not match the correct name or a larger word: %s", (text) => {
  expect(hasDanyaWrittenLoylexNameMistake(message(text))).toBe(false);
});

test("matches a misspelling next to punctuation and in captions", () => {
  const captionMessage = message("эй, ЛЕЙЛОЕКС!");
  delete captionMessage.text;
  captionMessage.caption = "эй, ЛЕЙЛОЕКС!";

  expect(hasDanyaWrittenLoylexNameMistake(captionMessage)).toBe(true);
});

test("only reacts to Danya's Telegram user ID", () => {
  expect(hasDanyaWrittenLoylexNameMistake(message("Лейло", 849670500))).toBe(false);
});
