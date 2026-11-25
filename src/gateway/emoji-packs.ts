import type { TelegramMessage } from "../shared/types.ts";
import type { LoylexDatabase } from "./database.ts";
import { richMessageLimitBytes } from "./presentation.ts";
import { TelegramApiError, type TelegramClient } from "./telegram.ts";

type PackSticker = { emoji?: string; custom_emoji_id?: string };
type EmojiPack = Map<string, string[]>;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const emojiKey = (value: string): string => value.replace(/[\uFE0E\uFE0F]/gu, "");
const encoder = new TextEncoder();

export function buildEmojiPack(stickers: PackSticker[]): EmojiPack {
  const pack: EmojiPack = new Map();
  for (const { emoji, custom_emoji_id: id } of stickers) {
    if (
      !emoji ||
      !id ||
      !/^\d+$/.test(id) ||
      !/(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}|\u20E3)/u.test(emoji)
    )
      continue;
    const key = emojiKey(emoji);
    const variants = pack.get(key) ?? [];
    if (!variants.includes(id)) variants.push(id);
    pack.set(key, variants);
  }
  return pack;
}

export function applyEmojiPack(
  markdown: string,
  pack: EmojiPack,
  byteLimit: number,
  random = Math.random,
): string {
  // Preserve Markdown syntax whose contents are interpreted as code, URLs, or markup.
  const protectedSyntax = new RegExp(
    [
      /^ {0,3}(?<fence>`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\k<fence>[^\S\n]*$|(?![\s\S]))/,
      /(?<ticks>`+)[^\n]*?\k<ticks>/,
      /\$\$[\s\S]*?\$\$/,
      /!?\[(?:\\.|[^\]\\])*\](?:\((?:\\.|[^()\\]|\([^()]*\))*\)|\[[^\]]*\])/,
      /^ {0,3}\[[^\]]+\]:[^\n]*/,
      /<(?<tag>tg-emoji|code|pre)\b[^>]*>[\s\S]*?<\/\k<tag>\s*>/,
      /<[^>\n]+>/,
      /(?:https?:\/\/|tg:\/\/|www\.)[^\s<>]+/,
      /\\[^\n]/,
    ]
      .map((pattern) => pattern.source)
      .join("|"),
    "gimu",
  );

  const replaceText = (text: string): string => {
    let result = "";
    for (const { segment } of graphemes.segment(text)) {
      const variants = pack.get(emojiKey(segment));
      const id = variants?.[Math.floor(random() * variants.length)];
      result += id ? `![${segment}](tg://emoji?id=${id})` : segment;
    }
    return result;
  };

  let result = "";
  let offset = 0;
  for (const match of markdown.matchAll(protectedSyntax)) {
    result += replaceText(markdown.slice(offset, match.index)) + match[0];
    offset = match.index + match[0].length;
  }
  result += replaceText(markdown.slice(offset));
  return encoder.encode(result).length <= byteLimit ? result : markdown;
}

async function loadPack(telegram: TelegramClient, name: string): Promise<EmojiPack> {
  const set = await telegram.call<{ sticker_type: string; stickers: PackSticker[] }>(
    "getStickerSet",
    { name },
  );
  return buildEmojiPack(set.sticker_type === "custom_emoji" ? set.stickers : []);
}

export async function handleEmojiPackCommand(
  database: LoylexDatabase,
  telegram: TelegramClient,
  message: TelegramMessage,
  botUsername: string | undefined,
  userId: number | null,
  send: (text: string) => Promise<void>,
): Promise<boolean> {
  const match = (message.text ?? "")
    .trim()
    .match(/^\/emoji_pack(?:@([a-z0-9_]+))?(?:\s+([\s\S]+))?$/iu);
  if (!match || (match[1] && match[1].toLowerCase() !== botUsername?.toLowerCase())) return false;
  if (userId === null) return true;
  const input = match[2];
  if (!input) {
    const pack = database.emojiPack(userId);
    await send(
      `${pack ? `Твой эмодзипак — \`${pack}\`.` : "Эмодзипак выключен."}\n` +
        "Чтобы включить, отправь `/emoji_pack ИМЯ` или укажи ссылку t.me/addemoji. Чтобы выключить, отправь `/emoji_pack off`.",
    );
    return true;
  }
  if (input.toLowerCase() === "off") {
    database.setEmojiPack(userId, null);
    await send("Эмодзипак выключен.");
    return true;
  }
  const name = input
    .replace(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/addemoji\//iu, "")
    .replace(/\/$/u, "");
  if (!/^[a-z0-9_]{1,128}$/iu.test(name)) {
    await send("Укажи имя эмодзипака или ссылку t.me/addemoji.");
    return true;
  }
  try {
    if ((await loadPack(telegram, name)).size === 0) {
      await send("В этом наборе нет подходящих кастомных эмодзи.");
      return true;
    }
  } catch (error) {
    await send(
      error instanceof TelegramApiError && error.errorCode === 400
        ? "Telegram не нашёл такой набор. Проверь имя или ссылку."
        : "Не удалось получить набор у Telegram. Попробуй позже.",
    );
    return true;
  }
  database.setEmojiPack(userId, name);
  await send(`Эмодзипак \`${name}\` включён для твоих итоговых ответов.`);
  return true;
}

async function loadUserEmojiPack(
  database: LoylexDatabase,
  telegram: TelegramClient,
  userId: number | null,
): Promise<EmojiPack | undefined> {
  const name = userId === null ? undefined : database.emojiPack?.(userId);
  if (!name) return undefined;
  try {
    return await loadPack(telegram, name);
  } catch (error) {
    console.warn("Could not load final reply emoji pack", name, error);
    return undefined;
  }
}

export async function finalReplySender(
  database: LoylexDatabase,
  telegram: TelegramClient,
  address: { chatId: number; userId: number | null },
): Promise<
  (markdown: string, options: Parameters<TelegramClient["sendRich"]>[2]) => Promise<TelegramMessage>
> {
  const { chatId, userId } = address;
  const pack = await loadUserEmojiPack(database, telegram, userId);
  return async (markdown, options) => {
    const decorated = pack?.size ? applyEmojiPack(markdown, pack, richMessageLimitBytes) : markdown;
    if (decorated !== markdown) {
      try {
        return await telegram.sendRich(chatId, decorated, options);
      } catch (error) {
        // A rejected rich document has not been sent. Retry without custom emoji.
        if (!(error instanceof TelegramApiError) || error.errorCode !== 400) throw error;
      }
    }
    return telegram.sendRich(chatId, markdown, options);
  };
}
