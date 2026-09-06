import { expect, test } from "bun:test";
import { buildFinalEmojiMap, replaceFinalEmojis } from "../src/gateway/final-emojis.ts";

test("groups custom emoji stickers by their base emoji", () => {
  const emojiMap = buildFinalEmojiMap([
    { type: "custom_emoji", emoji: "😂", custom_emoji_id: "100" },
    { type: "custom_emoji", emoji: "😂", custom_emoji_id: "101" },
    { type: "custom_emoji", emoji: "☕️", custom_emoji_id: "102" },
    { type: "regular", emoji: "😂", custom_emoji_id: "103" },
    { type: "custom_emoji", emoji: "🙂", custom_emoji_id: "not-an-id" },
  ]);

  expect(emojiMap.get("😂")).toEqual([
    { id: "100", fallback: "😂" },
    { id: "101", fallback: "😂" },
  ]);
  expect(emojiMap.get("☕")).toEqual([{ id: "102", fallback: "☕️" }]);
  expect(emojiMap.has("🙂")).toBe(false);
});

test("replaces mapped emoji while preserving rich code and custom emoji", () => {
  const emojiMap = buildFinalEmojiMap([
    { type: "custom_emoji", emoji: "😂", custom_emoji_id: "100" },
    { type: "custom_emoji", emoji: "😂", custom_emoji_id: "101" },
    { type: "custom_emoji", emoji: "👍", custom_emoji_id: "102" },
  ]);
  let randomCall = 0;

  const result = replaceFinalEmojis(
    'да 😂 👍 `😂` ```\n😂\n``` <tg-emoji emoji-id="999">😂</tg-emoji>',
    emojiMap,
    () => (randomCall++ === 0 ? 0 : 0.99),
  );

  expect(result).toBe(
    'да <tg-emoji emoji-id="100">😂</tg-emoji> <tg-emoji emoji-id="102">👍</tg-emoji> `😂` ```\n😂\n``` <tg-emoji emoji-id="999">😂</tg-emoji>',
  );
});

test("matches a skin-tone variant to its base emoji", () => {
  const emojiMap = buildFinalEmojiMap([
    { type: "custom_emoji", emoji: "👍", custom_emoji_id: "102" },
  ]);

  expect(replaceFinalEmojis("👍🏽", emojiMap)).toBe('<tg-emoji emoji-id="102">👍</tg-emoji>');
});
