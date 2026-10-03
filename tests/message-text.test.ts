import { expect, test } from "bun:test";
import { detectTrigger } from "../src/gateway/triggers.ts";
import { messageText } from "../src/shared/message-text.ts";
import type { TelegramMessage } from "../src/shared/types.ts";

test("reads the Rich-only request that previously became an attachment fallback", () => {
  const message: TelegramMessage = {
    message_id: 1,
    date: 1,
    chat: { id: -1, type: "supergroup" },
    reply_to_message: {
      message_id: 2,
      date: 1,
      chat: { id: -1, type: "supergroup" },
      from: { id: 3, is_bot: true, first_name: "bot" },
    },
    rich_message: {
      blocks: [
        { type: "paragraph", text: "Найди примеры видео генераций" },
        {
          type: "list",
          items: [
            {
              label: "•",
              blocks: [{ type: "paragraph", text: { type: "bold", text: "LTX-2.3 FP8" } }],
            },
          ],
        },
      ],
    },
  };
  expect(messageText(message)).toBe("Найди примеры видео генераций\n• LTX-2.3 FP8");
  expect(detectTrigger(message, 3)?.prompt).toBe(messageText(message));
});

test("preserves nested reply content, links and table cells without reading identity fields", () => {
  expect(
    messageText({
      rich_message: {
        blocks: [
          {
            type: "details",
            summary: "Details",
            blocks: [
              {
                type: "paragraph",
                text: [
                  "See ",
                  { type: "url", text: { type: "bold", text: "demo" }, url: "https://example.com" },
                ],
              },
            ],
          },
          { type: "table", cells: [[{ text: "Model" }, { text: "LTX" }]] },
          { type: "paragraph", from: { id: 426043802 }, text: "untrusted content" },
        ],
      },
    }),
  ).toBe("Details\nSee demo (https://example.com)\nModel | LTX\nuntrusted content");
  expect(messageText({ text: "plain", rich_message: { blocks: [{ text: "rich" }] } })).toBe(
    "plain",
  );
});
