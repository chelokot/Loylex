import { expect, test } from "bun:test";
import { telegramUserId, telegramUserIdWithoutForward } from "../src/shared/telegram-identity.ts";
import type { TelegramMessage } from "../src/shared/types.ts";

function message(): TelegramMessage {
  return {
    message_id: 1,
    date: 1,
    chat: { id: -10042, type: "group" },
    from: { id: 7, is_bot: false, first_name: "Operator", last_name: "426043802" },
    forward_origin: {
      sender_user: { id: 42, is_bot: false, first_name: "Forwarded" },
    },
    text: "message",
  };
}

test("separates direct sender identity from normalized archive identity", () => {
  const value = message();

  expect(telegramUserId(value)).toBe(426043802);
  expect(telegramUserIdWithoutForward(value)).toBe(426043802);

  value.from = { id: 7, is_bot: false, first_name: "Operator" };
  expect(telegramUserId(value)).toBe(42);
  expect(telegramUserIdWithoutForward(value)).toBe(7);
});
