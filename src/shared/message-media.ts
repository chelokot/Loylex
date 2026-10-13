import type { JsonValue } from "./types.ts";

const kinds = ["photo", "document", "audio", "video", "voice", "animation"] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Read media content only, never sender or authorization fields.
export function messageMedia(message: Record<string, unknown>): JsonValue[] {
  const result: JsonValue[] = [];
  for (const kind of kinds) {
    if (message[kind]) result.push({ kind, value: message[kind] as JsonValue });
  }
  let remaining = 1_000;
  function blocks(value: unknown, depth: number): void {
    if (depth > 32 || !Array.isArray(value)) return;
    for (const entry of value) {
      if (remaining-- <= 0) return;
      const block = record(entry);
      if (!block) continue;
      for (const kind of kinds) {
        if (block.type !== kind) continue;
        const media = block[kind];
        if (kind === "photo" ? Array.isArray(media) : record(media) !== null) {
          result.push({ kind, value: media as JsonValue });
        }
      }
      blocks(block.blocks, depth + 1);
      if (block.type === "list" && Array.isArray(block.items)) {
        // List items are containers with their own blocks.
        blocks(block.items, depth + 1);
      }
    }
  }
  blocks(record(message.rich_message)?.blocks, 0);
  return result;
}
