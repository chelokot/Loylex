// Read content only: sender identity and authorization never come from Rich nodes.
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function richText(value: unknown, depth = 0): string {
  if (depth > 32) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => richText(item, depth + 1)).join("");
  const node = record(value);
  if (!node) return "";
  const text = richText(node.text, depth + 1);
  if (node.type === "url" && typeof node.url === "string") {
    return `${text} (${node.url})`;
  }
  return text;
}

function richBlocks(value: unknown, depth = 0): string {
  if (depth > 32 || !Array.isArray(value)) return "";
  return value
    .map((value) => {
      const block = record(value);
      if (!block) return "";
      if (block.type === "list" && Array.isArray(block.items)) {
        return block.items
          .map((value) => {
            const item = record(value);
            return item ? `${richText(item.label)} ${richBlocks(item.blocks, depth + 1)}` : "";
          })
          .join("\n");
      }
      if (block.type === "table" && Array.isArray(block.cells)) {
        return block.cells
          .map((row) =>
            Array.isArray(row) ? row.map((cell) => richText(record(cell)?.text)).join(" | ") : "",
          )
          .join("\n");
      }
      return [
        richText(block.summary),
        richText(block.text),
        richText(block.caption),
        richBlocks(block.blocks, depth + 1),
      ]
        .filter(Boolean)
        .join("\n");
    })
    .filter(Boolean)
    .join("\n");
}

export function messageText(message: {
  text?: unknown;
  caption?: unknown;
  rich_message?: unknown;
}): string {
  if (typeof message.text === "string" && message.text.length) return message.text;
  if (typeof message.caption === "string" && message.caption.length) return message.caption;
  return richBlocks(record(message.rich_message)?.blocks);
}

export function withTelegramFormatting(text: string, source: Record<string, unknown>): string {
  const original = source.text || source.caption;
  const entities = source.text ? source.entities : source.caption_entities;
  if (typeof original !== "string" || !Array.isArray(entities)) return text;

  const spans = entities.flatMap((value) => {
    const entity = record(value);
    if (!entity) return [];
    const { type, offset, length, url, language, custom_emoji_id: customEmojiId } = entity;
    if (
      typeof type !== "string" ||
      typeof offset !== "number" ||
      typeof length !== "number" ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length <= 0 ||
      offset + length > original.length
    )
      return [];

    // Telegram offsets and JavaScript string indices both count UTF-16 code units.
    return [
      {
        type,
        offset,
        text: original.slice(offset, offset + length),
        ...(typeof url === "string" ? { url } : {}),
        ...(typeof language === "string" ? { language } : {}),
        ...(typeof customEmojiId === "string" ? { customEmojiId } : {}),
      },
    ];
  });
  return spans.length
    ? `${text}\n[Telegram formatting in original text: ${JSON.stringify(spans)}]`
    : text;
}
