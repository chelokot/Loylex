import { afterEach, expect, test } from "bun:test";
import {
  applyEmojiPack,
  buildEmojiPack,
  handleEmojiPackCommand,
} from "../src/gateway/emoji-packs.ts";
import type { TelegramClient } from "../src/gateway/telegram.ts";
import { message, removeDatabases, setup } from "./fixtures/database.ts";

const stickers = [
  { emoji: "❤️", custom_emoji_id: "123" },
  { emoji: "❤", custom_emoji_id: "456" },
];
const pack = buildEmojiPack(stickers);

afterEach(removeDatabases);

test("selects variants for matching graphemes and retains plain text when expansion exceeds the limit", () => {
  expect(applyEmojiPack("❤ ❤️ 👍🏽", pack, 1_000, () => 0.75)).toBe(
    "![❤](tg://emoji?id=456) ![❤️](tg://emoji?id=456) 👍🏽",
  );
  expect(applyEmojiPack("❤️", pack, 10)).toBe("❤️");
});

test("preserves code, formulas, links and existing custom emoji", () => {
  const syntax = [
    "`❤️`",
    "~~~txt\n❤️\n~~~",
    "$$❤️$$",
    "[❤️](https://example.test/a(b)/❤️)",
    "![❤️](tg://emoji?id=999)",
    '<tg-emoji emoji-id="999">❤️</tg-emoji>',
  ].join("\n");
  expect(applyEmojiPack(`${syntax}\n❤️`, pack, 1_000, () => 0)).toBe(
    `${syntax}\n![❤️](tg://emoji?id=123)`,
  );
});

test("validates the pack and changes only the requesting user's setting", async () => {
  const database = setup();
  const telegram = {
    async call(method: string, body: { name: string }) {
      expect(method).toBe("getStickerSet");
      expect(body.name).toBe("hearts");
      return { sticker_type: "custom_emoji", stickers };
    },
  } as unknown as TelegramClient;
  const replies: string[] = [];
  const send = async (text: string) => {
    replies.push(text);
  };
  expect(
    await handleEmojiPackCommand(
      database,
      telegram,
      message(1, "/emoji_pack@Loylex https://t.me/addemoji/hearts"),
      "Loylex",
      7,
      send,
    ),
  ).toBe(true);
  expect(database.emojiPack(7)).toBe("hearts");
  expect(database.emojiPack(8)).toBeUndefined();
  await handleEmojiPackCommand(
    database,
    telegram,
    message(2, "/emoji_pack off"),
    "Loylex",
    7,
    send,
  );
  expect(database.emojiPack(7)).toBeUndefined();
  expect(replies).toHaveLength(2);
});
