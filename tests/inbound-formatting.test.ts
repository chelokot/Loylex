import { expect, test } from "bun:test";
import { detectTrigger, promptWithQuote } from "../src/gateway/triggers.ts";
import { messageText, withTelegramFormatting } from "../src/shared/message-text.ts";
import type { TelegramMessage } from "../src/shared/types.ts";

test("keeps formatting through trigger stripping and resolves Telegram UTF-16 offsets", () => {
  const message: TelegramMessage = {
    message_id: 1,
    date: 0,
    chat: { id: -1, type: "supergroup" },
    text: "лейло 🙂 жирный ссылка",
    entities: [
      { type: "underline", offset: 0, length: 6 },
      { type: "bold", offset: 9, length: 6 },
      { type: "text_link", offset: 16, length: 6, url: "https://example.com" },
    ],
  };

  const trigger = detectTrigger(message, 42);
  expect(trigger?.prompt).toBe("🙂 жирный ссылка");
  expect(promptWithQuote(message, trigger?.prompt ?? "")).toBe(
    '🙂 жирный ссылка\n[Telegram formatting in original text: [{"type":"underline","offset":0,"text":"лейло "},{"type":"bold","offset":9,"text":"жирный"},{"type":"text_link","offset":16,"text":"ссылка","url":"https://example.com"}]]',
  );
});

test("reads caption entities and ignores invalid ranges", () => {
  const message = {
    caption: "🙂 фото",
    caption_entities: [
      { type: "strikethrough", offset: 3, length: 4 },
      { type: "bold", offset: 4, length: 99 },
    ],
  };
  expect(withTelegramFormatting(messageText(message), message)).toBe(
    '🙂 фото\n[Telegram formatting in original text: [{"type":"strikethrough","offset":3,"text":"фото"}]]',
  );
});
