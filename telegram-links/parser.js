const telegramLinkPattern =
  /(?<![\w.-])(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/c\/([1-9]\d{0,14})\/([1-9]\d{0,19})(?:[?#][^\s<>]*)?/giu;

export function parseTelegramLinks(input) {
  const source = typeof input === "string" ? input : "";
  const groups = [];
  const groupsByChatId = new Map();
  const invalidLines = [];
  let linkCount = 0;

  source.split(/\r?\n/).forEach((line, index) => {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      return;
    }

    const matches = [...line.matchAll(telegramLinkPattern)];
    if (matches.length === 0) {
      invalidLines.push({ lineNumber: index + 1, text: trimmedLine });
      return;
    }

    for (const match of matches) {
      const internalChatId = match[1];
      const messageId = match[2];
      if (!internalChatId || !messageId) {
        continue;
      }

      linkCount += 1;
      const chatId = `-100${internalChatId}`;
      let group = groupsByChatId.get(chatId);
      if (!group) {
        group = { chatId, messageIds: [] };
        groupsByChatId.set(chatId, group);
        groups.push(group);
      }
      if (!group.messageIds.includes(messageId)) {
        group.messageIds.push(messageId);
      }
    }
  });

  return {
    groups,
    invalidLines,
    linkCount,
    uniqueMessageCount: groups.reduce((count, group) => count + group.messageIds.length, 0),
  };
}

export function formatTelegramLinks(result) {
  return result.groups
    .map(({ chatId, messageIds }) => `${chatId}: ${messageIds.join(", ")}`)
    .join("\n");
}
