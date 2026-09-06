export type FinalEmojiSticker = {
  type?: string;
  emoji?: string;
  custom_emoji_id?: string;
};

export type FinalEmojiVariant = {
  id: string;
  fallback: string;
};

export type FinalEmojiMap = ReadonlyMap<string, readonly FinalEmojiVariant[]>;

export const finalEmojiPackName = "rndnemfx2";

const variationSelectors = /[\uFE0E\uFE0F]/gu;
const emojiModifiers = /\p{Emoji_Modifier}/gu;
const customEmojiId = /^\d+$/;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function emojiKey(value: string): string {
  return value.normalize("NFC").replace(variationSelectors, "").replace(emojiModifiers, "");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function buildFinalEmojiMap(stickers: readonly FinalEmojiSticker[]): FinalEmojiMap {
  const groups = new Map<string, FinalEmojiVariant[]>();
  for (const sticker of stickers) {
    if (
      sticker.type !== "custom_emoji" ||
      typeof sticker.emoji !== "string" ||
      sticker.emoji.length === 0 ||
      typeof sticker.custom_emoji_id !== "string" ||
      !customEmojiId.test(sticker.custom_emoji_id)
    ) {
      continue;
    }
    const key = emojiKey(sticker.emoji);
    if (!key) {
      continue;
    }
    const variants = groups.get(key) ?? [];
    if (!variants.some((variant) => variant.id === sticker.custom_emoji_id)) {
      variants.push({ id: sticker.custom_emoji_id, fallback: sticker.emoji });
    }
    groups.set(key, variants);
  }
  return groups;
}

function replaceEmojiText(text: string, emojiMap: FinalEmojiMap, random: () => number): string {
  let result = "";
  for (const { segment } of segmenter.segment(text)) {
    const variants = emojiMap.get(emojiKey(segment));
    if (!variants || variants.length === 0) {
      result += segment;
      continue;
    }
    const randomIndex = Math.floor(random() * variants.length);
    const index = Math.min(Math.max(randomIndex, 0), variants.length - 1);
    const variant = variants[index] ?? variants[0];
    result += variant
      ? `<tg-emoji emoji-id="${variant.id}">${escapeHtml(variant.fallback)}</tg-emoji>`
      : segment;
  }
  return result;
}

function tagEnd(markdown: string, start: number): number {
  const first = markdown[start + 1];
  if (!first || !/[A-Za-z!/]/.test(first)) {
    return -1;
  }
  let quote = "";
  for (let index = start + 1; index < markdown.length; index += 1) {
    const character = markdown[index];
    if (character === "\n") {
      return -1;
    }
    if (quote) {
      if (character === quote) {
        quote = "";
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function isCustomEmojiTag(markdown: string, start: number): boolean {
  return (
    markdown.startsWith("<tg-emoji", start) &&
    /[\s>]/.test(markdown[start + "<tg-emoji".length] ?? "")
  );
}

export function replaceFinalEmojis(
  markdown: string,
  emojiMap: FinalEmojiMap,
  random: () => number = Math.random,
): string {
  if (markdown.length === 0 || emojiMap.size === 0) {
    return markdown;
  }

  let result = "";
  let cursor = 0;
  while (cursor < markdown.length) {
    const fence = markdown.startsWith("```", cursor)
      ? "```"
      : markdown.startsWith("~~~", cursor)
        ? "~~~"
        : null;
    if (fence) {
      const end = markdown.indexOf(fence, cursor + fence.length);
      if (end === -1) {
        return result + markdown.slice(cursor);
      }
      const after = end + fence.length;
      result += markdown.slice(cursor, after);
      cursor = after;
      continue;
    }

    if (markdown[cursor] === "`") {
      let delimiterLength = 1;
      while (markdown[cursor + delimiterLength] === "`") {
        delimiterLength += 1;
      }
      const delimiter = "`".repeat(delimiterLength);
      const end = markdown.indexOf(delimiter, cursor + delimiterLength);
      if (end === -1) {
        return result + markdown.slice(cursor);
      }
      const after = end + delimiterLength;
      result += markdown.slice(cursor, after);
      cursor = after;
      continue;
    }

    if (isCustomEmojiTag(markdown, cursor)) {
      const openEnd = tagEnd(markdown, cursor);
      const closeTag = "</tg-emoji>";
      const closeStart = openEnd === -1 ? -1 : markdown.indexOf(closeTag, openEnd + 1);
      if (closeStart !== -1) {
        const after = closeStart + closeTag.length;
        result += markdown.slice(cursor, after);
        cursor = after;
        continue;
      }
    }

    if (markdown[cursor] === "<") {
      const end = tagEnd(markdown, cursor);
      if (end !== -1) {
        result += markdown.slice(cursor, end + 1);
        cursor = end + 1;
        continue;
      }
    }

    let end = cursor + 1;
    while (end < markdown.length && markdown[end] !== "`" && markdown[end] !== "<") {
      end += 1;
    }
    result += replaceEmojiText(markdown.slice(cursor, end), emojiMap, random);
    cursor = end;
  }
  return result;
}
